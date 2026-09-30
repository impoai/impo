package ai.impo.client

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

@Serializable data class OutboxEntry(val pending: PendingMessage, val receipt: MessageReceipt? = null, val taskReceipt: TaskReceipt? = null)
interface ConversationOutboxStore {
    suspend fun load(accountId: String, taskId: String?): OutboxEntry?
    suspend fun save(entry: OutboxEntry)
    suspend fun remove(accountId: String, taskId: String?)
}
/** Files contain message content, never authentication tokens; app supplies its private files directory. */
class FileConversationOutboxStore(private val directory: File) : ConversationOutboxStore {
    private val lock = Mutex()
    override suspend fun load(accountId: String, taskId: String?): OutboxEntry? = lock.withLock {
        val file = file(accountId, taskId)
        if (!file.exists()) return@withLock null
        val entry = ProtocolJson.decodeFromString<OutboxEntry>(file.readText(Charsets.UTF_8))
        if (entry.pending.accountId != accountId || entry.pending.taskId != taskId) throw ProtocolException("Outbox ownership mismatch")
        entry
    }
    override suspend fun save(entry: OutboxEntry) = lock.withLock {
        directory.mkdirs()
        val target = file(entry.pending.accountId, entry.pending.taskId)
        val temporary = File(directory, "${target.name}.tmp")
        FileOutputStream(temporary).use { it.write(ProtocolJson.encodeToString(entry).toByteArray(Charsets.UTF_8)); it.fd.sync() }
        Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        Unit
    }
    override suspend fun remove(accountId: String, taskId: String?) = lock.withLock {
        val file = file(accountId, taskId)
        if (file.exists() && !file.delete()) throw java.io.IOException("Could not clear accepted message")
        Unit
    }
    private fun file(accountId: String, taskId: String?): File {
        val key = ProtocolJson.encodeToString(listOf(accountId, taskId))
        val hash = MessageDigest.getInstance("SHA-256").digest(key.toByteArray()).joinToString("") { "%02x".format(it) }
        return File(directory, "$hash.json")
    }
}
class MemoryConversationOutboxStore : ConversationOutboxStore {
    private val entries = mutableMapOf<Pair<String, String?>, OutboxEntry>()
    override suspend fun load(accountId: String, taskId: String?) = synchronized(entries) { entries[accountId to taskId] }
    override suspend fun save(entry: OutboxEntry) { synchronized(entries) { entries[entry.pending.accountId to entry.pending.taskId] = entry } }
    override suspend fun remove(accountId: String, taskId: String?) { synchronized(entries) { entries.remove(accountId to taskId) } }
}
data class ConversationState(
    val conversationId: String? = null,
    val title: String? = null,
    val messages: List<ConversationMessage> = emptyList(),
    val steps: List<StreamStep> = emptyList(),
    val tools: List<ToolState> = emptyList(),
    val busy: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
    val hasPendingMessage: Boolean = false,
    val activeSubmissionIds: Set<String> = emptySet(),
) { val activeSubmissionId: String? get() = activeSubmissionIds.firstOrNull() }

/** Non-UI conversation state. close() detaches subscriptions; cancel() explicitly cancels runs. */
class ConversationSession(
    private val client: ImpoClient,
    private val accountId: String,
    private val taskId: String? = null,
    private val store: ConversationOutboxStore,
    scope: CoroutineScope,
    private val deviceId: suspend () -> String? = { null },
) {
    private val sessionJob = Job(scope.coroutineContext[Job])
    private val sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
    private val mutableState = MutableStateFlow(ConversationState())
    val state: StateFlow<ConversationState> = mutableState.asStateFlow()
    private val operationMutex = Mutex()
    private val subscriptions = mutableMapOf<String, Job>()
    private var generation = 0

    suspend fun refresh() = operationMutex.withLock {
        mutableState.update { it.copy(loading = true, error = null) }
        try {
            assertOwner()
            val recovered = ConversationRecovery()
            var after = 0
            var first = true
            var active = emptyList<ActiveSubmission>()
            var title: String? = null
            var conversationId: String? = null
            while (true) {
                val page = if (taskId == null) client.conversation(after) else client.taskConversation(taskId, after).let {
                    title = it.title
                    ConversationPage(it.conversationId, it.messages, it.activeSubmissions, it.hasMore, it.nextAfterSequence)
                }
                if (first) { recovered.replace(page); active = page.activeSubmissions; conversationId = page.conversationId; first = false }
                else recovered.merge(page)
                if (!page.hasMore) break
                if (page.nextAfterSequence <= after) throw ProtocolException("History pagination did not advance")
                after = page.nextAfterSequence
            }
            var pending = store.load(accountId, taskId)
            if (pending?.receipt != null && recovered.messages.any { it.id == pending!!.receipt!!.messageId }) {
                store.remove(accountId, taskId); pending = null
            }
            // Accepted receipt remains recoverable even if a page predates the new server message.
            pending?.receipt?.let { receipt ->
                if (active.none { it.submissionId == receipt.submissionId }) {
                    val run = client.submission(receipt.submissionId)
                    if (!run.isTerminal) active = active + ActiveSubmission(run.submissionId, run.messageId, run.status)
                }
            }
            generation++
            subscriptions.values.forEach { it.cancel() }; subscriptions.clear()
            mutableState.value = ConversationState(conversationId, title, recovered.messages,
                busy = active.isNotEmpty(), loading = false, hasPendingMessage = pending != null,
                activeSubmissionIds = active.map { it.submissionId }.toSet())
            active.forEach { observe(it) }
        } catch (cancelled: CancellationException) { mutableState.update { it.copy(loading = false) }; throw cancelled }
          catch (error: Exception) { mutableState.update { it.copy(loading = false, error = displayError(error)) } }
    }
    suspend fun send(text: String) = operationMutex.withLock {
        assertOwner()
        check(store.load(accountId, taskId) == null) { "Retry the pending message before sending another" }
        val command = MessageCommand.create(text)
        val pending = PendingMessage(accountId, command, taskId, if (taskId == null) deviceId() else null)
        store.save(OutboxEntry(pending))
        transmit(OutboxEntry(pending))
    }
    suspend fun retryPending() {
        val hadPending = operationMutex.withLock {
            assertOwner()
            val entry = store.load(accountId, taskId)
            if (entry == null) false else { transmit(entry); true }
        }
        // A history/stream error can occur after acceptance cleared the outbox.
        // Retry must reattach to the existing run, never submit its prompt again.
        if (!hadPending) refresh()
    }
    private suspend fun transmit(entry: OutboxEntry) {
        mutableState.update { it.copy(busy = true, error = null, hasPendingMessage = true) }
        try {
            val receipt = entry.receipt ?: entry.pending.send(client).also { store.save(entry.copy(receipt = it)) }
            assertOwner()
            val createdAt = entry.pending.command.clientContext?.currentDate ?: java.time.Instant.now().toString()
            val user = ConversationMessage(receipt.messageId, "user", (mutableState.value.messages.maxOfOrNull { it.sequence } ?: 0) + 1,
                entry.pending.command.text, "completed", createdAt)
            mutableState.update { old -> old.copy(messages = if (old.messages.any { it.id == user.id }) old.messages else old.messages + user,
                activeSubmissionIds = old.activeSubmissionIds + receipt.submissionId) }
            val run = client.submission(receipt.submissionId)
            if (run.isTerminal) {
                mutableState.update { it.copy(busy = false, activeSubmissionIds = it.activeSubmissionIds - run.submissionId) }
                sessionScope.launch { refresh() }
            } else observe(ActiveSubmission(run.submissionId, run.messageId, run.status))
        } catch (cancelled: CancellationException) { throw cancelled }
          catch (error: Exception) { mutableState.update { it.copy(busy = it.activeSubmissionIds.isNotEmpty(), error = displayError(error), hasPendingMessage = true) } }
    }
    private fun observe(active: ActiveSubmission) {
        subscriptions.remove(active.submissionId)?.cancel()
        val observedGeneration = generation
        subscriptions[active.submissionId] = sessionScope.launch {
            try {
                client.streamSubmission(active.submissionId).collect { stream ->
                    if (generation != observedGeneration) return@collect
                    val messageId = stream.messageId ?: return@collect
                    mutableState.update { old ->
                        val existing = old.messages.firstOrNull { it.id == messageId }
                        val message = ConversationMessage(messageId, "assistant", existing?.sequence ?: ((old.messages.maxOfOrNull { it.sequence } ?: 0) + 1),
                            stream.text, stream.status ?: active.status, existing?.createdAt ?: java.time.Instant.now().toString())
                        val terminal = stream.done || stream.status in setOf("completed", "failed", "cancelled")
                        val ids = if (terminal) old.activeSubmissionIds - active.submissionId else old.activeSubmissionIds
                        old.copy(messages = old.messages.filterNot { it.id == messageId } + message, steps = stream.steps, tools = stream.tools,
                            activeSubmissionIds = ids, busy = ids.isNotEmpty(), error = stream.errors.lastOrNull() ?: old.error)
                    }
                }
                // Fetch persisted final text/status, and clear an outbox only after history proves acceptance.
                sessionScope.launch { refresh() }
            } catch (cancelled: CancellationException) { throw cancelled }
              catch (error: Exception) { if (generation == observedGeneration) mutableState.update { it.copy(busy = false, error = displayError(error)) } }
        }
    }
    suspend fun cancel() {
        assertOwner()
        try {
            state.value.activeSubmissionIds.forEach { client.cancelSubmission(it) }
            refresh() // cancelRequested may still be running: continue observing until terminal.
        } catch (cancelled: CancellationException) { throw cancelled }
          catch (error: Exception) { mutableState.update { it.copy(error = displayError(error)) } }
    }
    fun close() { sessionScope.cancel() }
    private suspend fun assertOwner() { if (client.currentAccountId() != accountId) throw AccountChangedException() }
    private fun displayError(error: Exception): String = when (error) {
        is ApiException -> error.message
        is ProtocolException -> "The response was interrupted. Refresh to recover the conversation."
        else -> "Unable to reach Impo. Your pending message is saved; try again."
    }
}
