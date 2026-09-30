package ai.impo.client

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import kotlin.random.Random

/** This persisted envelope prevents a queued operation crossing an account or conversation boundary. */
@Serializable data class PendingMessage(
    val accountId: String, val command: MessageCommand, val taskId: String? = null, val deviceId: String? = null,
) {
    init { require(accountId.isNotBlank()); require(taskId == null || deviceId == null) }
    suspend fun send(client: ImpoClient): MessageReceipt {
        if (client.currentAccountId() != accountId) throw AccountChangedException()
        return if (taskId == null) client.sendMessage(command, deviceId) else client.sendTaskMessage(taskId, command)
    }
}

/** Immutable exact wire bytes. Persist these bytes, not a later re-encoding of the object. */
class SealedAudioUpload private constructor(val ownerAccountId: String, private val content: ByteArray, val manifest: UploadManifest) {
    val bytes: ByteArray get() = content.copyOf()
    fun validateMatchingReceipt(receipt: BatchReceipt) {
        if (receipt.status != "accepted" || receipt.batchId != manifest.batch.batchId ||
            receipt.streamId != manifest.batch.streamId || receipt.sequence != manifest.batch.sequence)
            throw ProtocolException("Audio acknowledgment does not match the sealed batch")
    }
    companion object {
        fun create(ownerAccountId: String, batch: SealedBatch): SealedAudioUpload {
            // Normalize only before sealing. Retries/restores preserve the original bytes exactly.
            val canonical = batch.copy(items = batch.items.map { item ->
                item.copy(startedAt = wireTimestamp(Instant.parse(item.startedAt)), endedAt = wireTimestamp(Instant.parse(item.endedAt)),
                    locations = item.locations?.map { span -> span.copy(from = wireTimestamp(Instant.parse(span.from)),
                        to = wireTimestamp(Instant.parse(span.to)), capturedAt = wireTimestamp(Instant.parse(span.capturedAt))) })
            })
            return restore(ownerAccountId, ProtocolJson.encodeToString(canonical).toByteArray(Charsets.UTF_8))
        }
        fun restore(ownerAccountId: String, exactBytes: ByteArray): SealedAudioUpload {
            require(ownerAccountId.isNotBlank() && exactBytes.size in 1..1_500_000)
            val snapshot = exactBytes.copyOf()
            val text = Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(snapshot)).toString()
            val batch = ProtocolJson.decodeFromString<SealedBatch>(text)
            require(batch.sequence in 1..Int.MAX_VALUE && batch.items.size in 1..16)
            require(listOf(batch.batchId, batch.streamId, batch.sessionId).all { runCatching { java.util.UUID.fromString(it) }.isSuccess })
            require(batch.items.map { it.segmentId }.distinct().size == batch.items.size)
            var lastStart: Instant? = null
            var totalDuration = 0L
            var totalAudio = 0
            val items = batch.items.map { item ->
                require(runCatching { java.util.UUID.fromString(item.segmentId) }.isSuccess)
                require(item.mimeType in setOf("audio/mp4", "audio/m4a", "audio/wav", "audio/mpeg", "audio/aac"))
                val start = Instant.parse(item.startedAt); val end = Instant.parse(item.endedAt)
                require(end > start && (lastStart?.let { start >= it } ?: true))
                totalDuration += java.time.Duration.between(start, end).toMillis(); lastStart = start
                val audio = Base64.getDecoder().decode(item.audio)
                require(audio.isNotEmpty() && Base64.getEncoder().encodeToString(audio) == item.audio)
                totalAudio += audio.size
                ManifestItem(item.segmentId, item.startedAt, item.endedAt, item.mimeType, audio.size, item.locations)
            }
            require(totalAudio <= 1_048_576 && totalDuration <= 301_000)
            val sha256 = MessageDigest.getInstance("SHA-256").digest(snapshot).joinToString("") { "%02x".format(it) }
            return SealedAudioUpload(ownerAccountId, snapshot, UploadManifest(ManifestBatch(batch.batchId, batch.streamId, batch.sequence, batch.sessionId, items), sha256, snapshot.size))
        }
    }
}
interface UploadAcknowledgmentStore {
    /** Must return only after the matching receipt is durably written to account-scoped storage. */
    suspend fun persistAcknowledgment(accountId: String, receipt: BatchReceipt)
    suspend fun removeAcknowledgedBytes(accountId: String, batchId: String)
}
class AudioUploadCoordinator(private val client: ImpoClient, private val store: UploadAcknowledgmentStore) {
    suspend fun upload(batch: SealedAudioUpload): BatchReceipt {
        assertOwner(batch)
        val ticket = client.prepareAudioUpload(batch.manifest)
        val receipt = when (ticket.status) {
            "accepted" -> ticket.receipt ?: throw ProtocolException("Accepted upload has no receipt")
            "upload" -> { assertOwner(batch); client.uploadAudio(ticket, batch.bytes); assertOwner(batch); client.completeAudioUpload(batch.manifest.batch.batchId) }
            "uploaded" -> { assertOwner(batch); client.completeAudioUpload(batch.manifest.batch.batchId) }
            else -> throw ProtocolException("Unknown upload state")
        }
        batch.validateMatchingReceipt(receipt)
        assertOwner(batch)
        store.persistAcknowledgment(batch.ownerAccountId, receipt)
        store.removeAcknowledgedBytes(batch.ownerAccountId, receipt.batchId)
        return receipt
    }
    private suspend fun assertOwner(batch: SealedAudioUpload) { if (client.currentAccountId() != batch.ownerAccountId) throw AccountChangedException() }
}

@Serializable data class DeviceExecutionReceipt(
    val accountId: String, val invocationId: String, val toolName: String, val input: JsonElement,
    val result: DeviceResult,
)
interface DeviceReceiptStore {
    suspend fun load(accountId: String, invocationId: String): DeviceExecutionReceipt?
    /** Atomic durable write before network result submission. Never store a bearer token. */
    suspend fun save(receipt: DeviceExecutionReceipt)
}
fun interface DeviceToolExecutor { suspend fun execute(invocation: DeviceInvocation): JsonElement }
/** Only the server's owned pending/claim flow can authorize native execution. */
class DeviceToolRunner(
    private val client: ImpoClient, private val accountId: String, private val deviceId: String,
    private val store: DeviceReceiptStore, private val executor: DeviceToolExecutor,
    private val isEnabled: suspend (String) -> Boolean,
    private val now: () -> Instant = Instant::now,
) {
    private val mutex = Mutex()
    suspend fun runPending(): List<ToolResultReceipt> = mutex.withLock {
        assertOwner()
        client.pendingDeviceInvocations(deviceId).map { invocation ->
            assertOwner()
            if (invocation.deviceId != deviceId) throw ProtocolException("Invocation targets another device")
            if (Instant.parse(invocation.expiresAt) <= now()) throw ProtocolException("Device invocation has expired")
            val claim = client.claimDeviceInvocation(invocation.invocationId, deviceId)
            if (Instant.parse(claim.expiresAt) <= now()) throw ProtocolException("Device claim has expired")
            assertOwner()
            val saved = store.load(accountId, invocation.invocationId)
            val receipt = if (saved != null) {
                if (saved.accountId != accountId || saved.result.deviceId != deviceId || saved.result.executionId != claim.executionId ||
                    saved.toolName != invocation.toolName || saved.input != invocation.input)
                    throw ProtocolException("Saved device result conflicts with the current claim")
                saved
            } else {
                val result = try {
                    if (!isEnabled(invocation.toolName)) DeviceResult(deviceId, claim.executionId, false, error = "permission_revoked")
                    else { assertOwner(); DeviceResult(deviceId, claim.executionId, true, output = executor.execute(invocation)) }
                } catch (cancelled: CancellationException) { throw cancelled }
                  catch (_: Exception) { DeviceResult(deviceId, claim.executionId, false, error = "Native capability failed") }
                DeviceExecutionReceipt(accountId, invocation.invocationId, invocation.toolName, invocation.input, result).also { store.save(it) }
            }
            assertOwner()
            client.submitDeviceResult(invocation.invocationId, receipt.result).also { if (!it.accepted) throw ProtocolException("Device result was not accepted") }
        }
    }
    private suspend fun assertOwner() { if (client.currentAccountId() != accountId) throw AccountChangedException() }
}

/** Caller opts in only for operations whose stable identity makes retry safe. */
suspend fun <T> retryIdempotent(maxAttempts: Int = 3, initialDelayMillis: Long = 500, operation: suspend () -> T): T {
    require(maxAttempts > 0 && initialDelayMillis >= 0)
    var attempt = 0
    while (true) {
        try { return operation() }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: java.io.IOException) {
            attempt++
            val retryable = error !is ProtocolException && (error !is ApiException || (error.retryable && error.statusCode !in setOf(401, 403, 404, 409, 410)))
            if (!retryable || attempt >= maxAttempts) throw error
            val serverDelay = (error as? ApiException)?.retryAfter?.toLongOrNull()?.coerceIn(0, 120)?.times(1000)
            val backoff = (initialDelayMillis * (1L shl (attempt - 1).coerceAtMost(10))).coerceAtMost(30_000)
            delay(serverDelay ?: (backoff + if (backoff > 0) Random.nextLong(backoff / 4 + 1) else 0))
        }
    }
}

/** Full snapshots refresh formerly running messages; subsequent pages only merge by stable ID. */
class ConversationRecovery {
    private var conversationId: String? = null
    private val byId = linkedMapOf<String, ConversationMessage>()
    val messages: List<ConversationMessage> get() = byId.values.sortedWith(compareBy({ it.sequence }, { it.id }))
    fun replace(page: ConversationPage): List<ConversationMessage> {
        conversationId = page.conversationId; byId.clear(); page.messages.forEach { byId[it.id] = it }; return messages
    }
    fun merge(page: ConversationPage): List<ConversationMessage> {
        if (conversationId != page.conversationId) throw ProtocolException("Conversation identity changed during pagination")
        page.messages.forEach { byId[it.id] = it }; return messages
    }
}
