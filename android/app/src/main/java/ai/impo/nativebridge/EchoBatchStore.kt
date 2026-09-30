package ai.impo.nativebridge

import ai.impo.client.*
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.time.Instant
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

internal val nativeJson = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }

@Serializable internal data class CaptureJournal(
    val accountId: String, val batchId: String, val streamId: String, val sessionId: String,
    val segmentId: String, val sequence: Int, val startedAt: String,
    val locations: List<EchoLocationSpan> = emptyList(),
)
@Serializable internal data class StreamSequence(val streamId: String, val next: Int)

data class PendingAudio(val accountId: String, val manifest: UploadManifest, val bytes: ByteArray)

/** Private, account-scoped durable outbox. No network call may mutate sealed bytes. */
class EchoBatchStore(root: File, val accountId: String) {
    internal val directory = accountDirectory(root, accountId)

    @Synchronized internal fun begin(streamId: String, sessionId: String, startedAt: Instant): CaptureJournal {
        UUID.fromString(streamId); UUID.fromString(sessionId)
        val sequenceFile = File(directory, "stream-$streamId.json")
        val state = if (sequenceFile.exists()) nativeJson.decodeFromString<StreamSequence>(sequenceFile.readText())
                    else StreamSequence(streamId, 1)
        require(state.streamId == streamId && state.next in 1 until Int.MAX_VALUE)
        atomicWrite(sequenceFile, nativeJson.encodeToString(state.copy(next = state.next + 1)).toByteArray())
        val journal = CaptureJournal(accountId, UUID.randomUUID().toString(), streamId, sessionId,
            UUID.randomUUID().toString(), state.next, wireTimestamp(startedAt))
        activeJournals.add(pcmFile(journal.batchId).absolutePath)
        try { atomicWrite(journalFile(journal.batchId), nativeJson.encodeToString(journal).toByteArray()) }
        catch (failure: Exception) { activeJournals.remove(pcmFile(journal.batchId).absolutePath); throw failure }
        return journal
    }

    internal fun pcmFile(batchId: String): File = File(directory, "${validId(batchId)}.pcm")
    private fun journalFile(batchId: String) = File(directory, "${validId(batchId)}.capture.json")
    private fun batchFile(batchId: String) = File(directory, "${validId(batchId)}.batch.json")
    private fun receiptFile(batchId: String) = File(directory, "${validId(batchId)}.receipt.json")

    @Synchronized internal fun checkpoint(journal: CaptureJournal) {
        require(journal.accountId == accountId)
        atomicWrite(journalFile(journal.batchId), nativeJson.encodeToString(journal).toByteArray())
    }

    @Synchronized internal fun seal(journal: CaptureJournal): String? {
        require(journal.accountId == accountId)
        val pcm = pcmFile(journal.batchId)
        if (!pcm.exists() || pcm.length() < 2) {
            pcm.delete(); journalFile(journal.batchId).delete(); activeJournals.remove(pcm.absolutePath); return null
        }
        require(pcm.length() <= MAX_PCM_BYTES) { "Audio checkpoint exceeds batch limit; retained for recovery" }
        // A torn final sample is excluded; all preceding complete samples survive.
        val raw = pcm.readBytes().let { it.copyOf(it.size - it.size % 2) }
        val start = Instant.parse(journal.startedAt)
        val end = start.plusNanos(raw.size.toLong() / 2 * 1_000_000_000 / SAMPLE_RATE)
        require(Instant.parse(wireTimestamp(end)) > Instant.parse(wireTimestamp(start))) { "Audio checkpoint is too short; retained for recovery" }
        val locations = journal.locations.map { span -> span.copy(
            from = wireTimestamp(Instant.parse(span.from)), to = wireTimestamp(Instant.parse(span.to)),
            capturedAt = wireTimestamp(Instant.parse(span.capturedAt)))
        }.filter { Instant.parse(it.from) >= Instant.parse(wireTimestamp(start)) &&
            Instant.parse(it.to) <= Instant.parse(wireTimestamp(end)) && Instant.parse(it.to) > Instant.parse(it.from) }
        val batch = SealedBatch(journal.batchId, journal.streamId, journal.sequence, journal.sessionId,
            listOf(AudioItem(journal.segmentId, wireTimestamp(start), wireTimestamp(end), "audio/wav",
                Base64.getEncoder().encodeToString(wav(raw)), locations.takeIf { it.isNotEmpty() })))
        val bytes = nativeJson.encodeToString(batch).toByteArray(Charsets.UTF_8)
        require(bytes.size <= 1_500_000)
        val destination = batchFile(batch.batchId)
        if (!destination.exists()) atomicWrite(destination, bytes)
        else require(destination.readBytes().contentEquals(bytes)) { "Immutable batch conflict" }
        // Only the durable sealed representation replaces a capture journal.
        journalFile(journal.batchId).delete(); pcm.delete()
        activeJournals.remove(pcm.absolutePath)
        return batch.batchId
    }

    /** Called when no recording owns the journal, including after process death. */
    @Synchronized fun recover(): List<String> {
        val errors = mutableListOf<String>()
        directory.listFiles()?.filter { it.name.endsWith(".capture.json") }?.forEach { file ->
            runCatching {
                val journal = nativeJson.decodeFromString<CaptureJournal>(file.readText())
                if (pcmFile(journal.batchId).absolutePath !in activeJournals) seal(journal)
            }
                .onFailure { errors.add("A recording checkpoint could not be recovered: ${it.message}") }
        }
        directory.listFiles()?.filter { it.name.endsWith(".receipt.json") }?.forEach { file ->
            runCatching {
                val receipt = nativeJson.decodeFromString<BatchReceipt>(file.readText())
                if (batchFile(receipt.batchId).exists()) acknowledge(receipt)
            }.onFailure { errors.add("An upload receipt could not be reconciled: ${it.message}") }
        }
        return errors
    }

    @Synchronized fun pendingBatchIds(): List<String> = directory.listFiles().orEmpty()
        .filter { it.name.endsWith(".batch.json") && !File(directory, it.name.removeSuffix(".batch.json") + ".deleted").exists() }
        .sortedBy { it.lastModified() }.map { it.name.removeSuffix(".batch.json") }

    /** Load only one bounded file at a time, even after weeks offline. */
    @Synchronized fun loadPending(batchId: String): PendingAudio {
            val file = batchFile(batchId)
            require(file.length() in 1..1_500_000)
            val bytes = file.readBytes()
            require(bytes.size <= 1_500_000)
            val batch = nativeJson.decodeFromString<SealedBatch>(bytes.toString(Charsets.UTF_8))
            require(file == batchFile(batch.batchId) && batch.items.size in 1..16 && batch.sequence > 0)
            val items = batch.items.map { item ->
                ManifestItem(item.segmentId, item.startedAt, item.endedAt, item.mimeType,
                    Base64.getDecoder().decode(item.audio).size, item.locations)
            }
            require(items.sumOf { it.audioBytes } <= 1_048_576)
            return PendingAudio(accountId, UploadManifest(ManifestBatch(batch.batchId, batch.streamId, batch.sequence,
                batch.sessionId, items), sha256(bytes), bytes.size), bytes)
    }

    @Synchronized fun pending(): List<PendingAudio> = pendingBatchIds().map(::loadPending)
        .sortedWith(compareBy({ it.manifest.batch.items.first().startedAt }, { it.manifest.batch.sequence }))

    @Synchronized fun acknowledge(receipt: BatchReceipt) {
        val batchPath = batchFile(receipt.batchId)
        if (!batchPath.exists()) {
            val saved = receiptFile(receipt.batchId)
            require(saved.exists() && nativeJson.decodeFromString<BatchReceipt>(saved.readText()) == receipt) { "Missing batch or mismatched receipt" }
            return
        }
        val batch = nativeJson.decodeFromString<SealedBatch>(batchPath.readText())
        require(receipt.status == "accepted" && receipt.batchId == batch.batchId &&
            receipt.streamId == batch.streamId && receipt.sequence == batch.sequence) { "Mismatched durable receipt" }
        atomicWrite(receiptFile(batch.batchId), nativeJson.encodeToString(receipt).toByteArray())
        check(batchPath.delete()) { "Receipt saved; local batch cleanup will retry" }
    }

    /** HTTP 410 reflects explicit deletion. Stop retrying, preserve a local audit marker. */
    @Synchronized fun markDeleted(batchId: String) {
        atomicWrite(File(directory, "${validId(batchId)}.deleted"), Instant.now().toString().toByteArray())
        batchFile(batchId).delete()
    }

    fun pendingCount(): Int = directory.listFiles().orEmpty().count { it.name.endsWith(".batch.json") }

    private fun validId(id: String): String { require(UUID.fromString(id).toString() == id); return id }

    companion object {
        private val activeJournals = ConcurrentHashMap.newKeySet<String>()
        /** Drop only the in-process claim; the journal and speech bytes remain durable. */
        internal fun releaseJournal(file: File) { activeJournals.remove(file.absolutePath) }
        const val SAMPLE_RATE = 16000
        const val MAX_PCM_BYTES = SAMPLE_RATE * 2 * 25
        internal fun wav(pcm: ByteArray): ByteArray {
            val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            header.put("RIFF".toByteArray()).putInt(pcm.size + 36).put("WAVEfmt ".toByteArray())
            header.putInt(16).putShort(1).putShort(1).putInt(SAMPLE_RATE).putInt(SAMPLE_RATE * 2)
            header.putShort(2).putShort(16).put("data".toByteArray()).putInt(pcm.size)
            return header.array() + pcm
        }
    }
}

/** Syncs confirmed speech at most one second apart; never retains silence-only files. */
internal class SpeechJournalWriter(
    private val store: EchoBatchStore, private val streamId: String, private val sessionId: String,
    private val recordingStart: Instant, private val locations: EchoLocationHistory,
    private val onSealed: () -> Unit,
) : AutoCloseable {
    private var journal: CaptureJournal? = null
    private var output: FileOutputStream? = null
    private var writtenSamples = 0L
    private var syncedSamples = 0L

    fun accept(event: SpeechSegmenter.Event) {
        when (event) {
            is SpeechSegmenter.Event.Begin -> {
                check(output == null)
                val start = recordingStart.plusNanos(event.sample * 1_000_000_000 / EchoBatchStore.SAMPLE_RATE)
                journal = store.begin(streamId, sessionId, start)
                output = FileOutputStream(store.pcmFile(journal!!.batchId))
                writtenSamples = 0; syncedSamples = 0
                append(event.audio)
            }
            is SpeechSegmenter.Event.Append -> append(event.audio)
            is SpeechSegmenter.Event.End -> closeSegment()
        }
    }

    private fun append(audio: ShortArray) {
        val bytes = ByteBuffer.allocate(audio.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        audio.forEach { bytes.putShort(it) }
        check(writtenSamples * 2 + bytes.capacity() <= EchoBatchStore.MAX_PCM_BYTES)
        checkNotNull(output).write(bytes.array()); writtenSamples += audio.size
        if (writtenSamples - syncedSamples >= EchoBatchStore.SAMPLE_RATE) checkpoint()
    }

    private fun checkpoint() {
        val current = journal ?: return
        output?.fd?.sync(); syncedSamples = writtenSamples
        val start = Instant.parse(current.startedAt)
        val end = start.plusNanos(writtenSamples * 1_000_000_000 / EchoBatchStore.SAMPLE_RATE)
        journal = current.copy(locations = nativeJson.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(EchoLocationSpan.serializer()), locations.spans(start, end)))
        store.checkpoint(journal!!)
    }

    private fun closeSegment() {
        if (output == null) return
        checkpoint(); output?.close(); output = null
        store.seal(checkNotNull(journal)); journal = null; onSealed()
    }
    override fun close() {
        try { closeSegment() }
        finally {
            output?.close(); output = null
            journal?.let { EchoBatchStore.releaseJournal(store.pcmFile(it.batchId)) }
        }
    }
}
