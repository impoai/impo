package ai.impo.client

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Task creation uses a separate durable outbox lane; a lost 202 must not create another task. */
class DurableTaskCreator(
    private val client: ImpoClient,
    private val accountId: String,
    private val store: ConversationOutboxStore,
) {
    private val mutex = Mutex()
    suspend fun pendingCommand(): MessageCommand? = mutex.withLock {
        assertOwner(); store.load(accountId, CREATION_LANE)?.pending?.command
    }
    suspend fun create(text: String, attachmentIds: List<String> = emptyList()): TaskReceipt = mutex.withLock {
        assertOwner()
        require(text.length <= 4000) { "Task descriptions must be at most 4,000 characters" }
        val saved = store.load(accountId, CREATION_LANE)
        if (saved != null && (saved.pending?.command?.text != text || saved.pending?.command?.attachmentIds != attachmentIds))
            throw IllegalStateException("Recover your pending task before creating another task")
        val entry = saved ?: OutboxEntry(PendingMessage(accountId, MessageCommand.create(text, attachmentIds = attachmentIds), taskId = CREATION_LANE)).also { store.save(it) }
        submit(entry)
    }
    suspend fun retry(): TaskReceipt? = mutex.withLock {
        assertOwner(); store.load(accountId, CREATION_LANE)?.let { submit(it) }
    }
    /** Call after the accepted task is visible to the application; mismatched acknowledgment cannot drop work. */
    suspend fun acknowledge(taskId: String) = mutex.withLock {
        assertOwner()
        val entry = store.load(accountId, CREATION_LANE) ?: return@withLock
        if (entry.taskReceipt?.taskId != taskId) throw ProtocolException("Task acknowledgment does not match the accepted task")
        store.remove(accountId, CREATION_LANE)
    }
    private suspend fun submit(entry: OutboxEntry): TaskReceipt {
        assertOwner()
        entry.taskReceipt?.let { return it }
        val receipt = client.createTask(entry.pending?.command ?: throw ProtocolException("Task outbox contains a voice command"))
        assertOwner()
        store.save(entry.copy(taskReceipt = receipt))
        return receipt
    }
    private suspend fun assertOwner() { if (client.currentAccountId() != accountId) throw AccountChangedException() }
    private companion object { const val CREATION_LANE = "__task_creation__" }
}
