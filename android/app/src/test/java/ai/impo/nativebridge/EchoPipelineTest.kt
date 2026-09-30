package ai.impo.nativebridge

import ai.impo.client.BatchReceipt
import ai.impo.client.SealedBatch
import ai.impo.client.wireTimestamp
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files
import java.time.Instant
import java.util.Base64
import java.util.UUID
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.After
import org.junit.Test

class EchoPipelineTest {
    private val root = Files.createTempDirectory("impo-echo-test").toFile()
    private val start = Instant.parse("2026-09-01T10:00:00Z")
    @After fun clean() { root.deleteRecursively() }
    private fun id() = UUID.randomUUID().toString()
    private fun store(account: String = "account-a") = EchoBatchStore(root, account)

    @Test fun silenceAndShortTransientsNeverCreateDurableAudio() {
        val store = store()
        val segmenter = SpeechSegmenter()
        SpeechJournalWriter(store, id(), id(), start, EchoLocationHistory()) {}.use { writer ->
            repeat(500) { frame ->
                segmenter.consume(ShortArray(512), if (frame % 6 < 4) .99f else .01f).forEach(writer::accept)
            }
            segmenter.finish().forEach(writer::accept)
        }
        assertEquals(0, store.pendingCount())
        assertTrue(store.directory.listFiles().orEmpty().isEmpty())
    }

    @Test fun speechSurvivesProcessDeathWithoutStartingARecorder() {
        val store = store()
        val journal = store.begin(id(), id(), start)
        // Simulate a killed process after synchronized PCM plus one torn sample.
        store.pcmFile(journal.batchId).writeBytes(ByteArray(32001) { 42 })
        EchoBatchStore.releaseJournal(store.pcmFile(journal.batchId))
        assertTrue(EchoBatchStore(root, "account-a").recover().isEmpty())
        val pending = store.pending().single()
        val batch = nativeJson.decodeFromString<SealedBatch>(pending.bytes.toString(Charsets.UTF_8))
        assertEquals(wireTimestamp(start.plusSeconds(1)), batch.items.single().endedAt)
        assertEquals(journal.batchId, batch.batchId)
        assertEquals(32044, Base64.getDecoder().decode(batch.items.single().audio).size)
        assertFalse(store.pcmFile(journal.batchId).exists())
        val unchanged = pending.bytes
        store.recover()
        assertArrayEquals(unchanged, store.pending().single().bytes)
    }

    @Test fun longSpeechCreatesBoundedImmutableExactByteBatches() {
        val store = store()
        val segmenter = SpeechSegmenter()
        val stream = id(); val session = id()
        SpeechJournalWriter(store, stream, session, start, EchoLocationHistory()) {}.use { writer ->
            repeat(4000) { segmenter.consume(ShortArray(512) { 12345 }, .95f).forEach(writer::accept) }
            segmenter.finish().forEach(writer::accept)
        }
        val batches = store.pending()
        assertTrue(batches.size >= 5)
        assertEquals(batches.indices.map { it + 1 }, batches.map { it.manifest.batch.sequence })
        var precedingEnd: Instant? = null
        batches.forEach { pending ->
            assertEquals(pending.bytes.size, pending.manifest.byteLength)
            assertEquals(sha256(pending.bytes), pending.manifest.sha256)
            assertTrue(pending.bytes.size <= 1_500_000)
            val item = pending.manifest.batch.items.single()
            assertTrue(item.audioBytes in 45..800044)
            assertEquals(stream, pending.manifest.batch.streamId)
            assertEquals(session, pending.manifest.batch.sessionId)
            assertTrue(Instant.parse(item.endedAt) > Instant.parse(item.startedAt))
            precedingEnd?.let { assertEquals(it, Instant.parse(item.startedAt)) }
            precedingEnd = Instant.parse(item.endedAt)
        }
        assertEquals(start.plusNanos(4000L * 512 * 1_000_000_000 / 16000), precedingEnd)
        val before = batches.map { it.bytes.toList() }
        assertEquals(before, store.pending().map { it.bytes.toList() })
    }

    @Test fun mismatchedReceiptsNeverRemoveBytesAndAcceptanceIsDurable() {
        val store = store()
        val journal = store.begin(id(), id(), start)
        store.pcmFile(journal.batchId).writeBytes(ByteArray(32000))
        store.seal(journal)
        val original = store.pending().single().bytes
        val receipt = BatchReceipt(journal.batchId, journal.streamId, journal.sequence, "accepted")
        for (bad in listOf(receipt.copy(streamId = id()), receipt.copy(sequence = 2), receipt.copy(status = "uploaded"))) {
            assertThrows(IllegalArgumentException::class.java) { store.acknowledge(bad) }
            assertArrayEquals(original, store.pending().single().bytes)
        }
        store.acknowledge(receipt)
        store.acknowledge(receipt)
        assertEquals(0, store.pendingCount())
        assertTrue(File(store.directory, "${journal.batchId}.receipt.json").exists())
    }

    @Test fun acceptedReceiptReconcilesCrashBeforeFileCleanup() {
        val store = store()
        val journal = store.begin(id(), id(), start)
        store.pcmFile(journal.batchId).writeBytes(ByteArray(32000))
        store.seal(journal)
        val savedBatch = store.pending().single().bytes
        store.acknowledge(BatchReceipt(journal.batchId, journal.streamId, journal.sequence, "accepted"))
        File(store.directory, "${journal.batchId}.batch.json").writeBytes(savedBatch)
        assertTrue(store.recover().isEmpty())
        assertEquals(0, store.pendingCount())
    }

    @Test fun queuesRemainAccountIsolatedIncludingMaliciousPathLikeIds() {
        val store = store("../../some-account")
        val journal = store.begin(id(), id(), start)
        store.pcmFile(journal.batchId).writeBytes(ByteArray(32000)); store.seal(journal)
        assertEquals(1, store.pendingCount())
        assertEquals(0, store("another-account").pendingCount())
        assertEquals(root.canonicalFile, store.directory.parentFile.canonicalFile)
        assertThrows(IllegalArgumentException::class.java) { store("another-account").seal(journal) }
    }

    @Test fun explicitServerDeletionRetiresOnlyThatBatch() {
        val store = store()
        val journals = (1..2).map { store.begin(id(), id(), start) }
        journals.forEach { store.pcmFile(it.batchId).writeBytes(ByteArray(32000)); store.seal(it) }
        store.markDeleted(journals.first().batchId)
        assertEquals(journals.last().batchId, store.pending().single().manifest.batch.batchId)
        assertTrue(File(store.directory, "${journals.first().batchId}.deleted").exists())
    }

    @Test fun corruptCheckpointIsRetainedAndReported() {
        val store = store()
        val journal = store.begin(id(), id(), start)
        store.pcmFile(journal.batchId).writeBytes(ByteArray(EchoBatchStore.MAX_PCM_BYTES + 2))
        EchoBatchStore.releaseJournal(store.pcmFile(journal.batchId))
        assertEquals(1, store.recover().size)
        assertTrue(store.pcmFile(journal.batchId).exists())
        assertEquals(0, store.pendingCount())
    }

    @Test fun waveHeaderMatchesExactPcmFormatAndByteLength() {
        val pcm = byteArrayOf(0, 1, 2, 3)
        val wav = EchoBatchStore.wav(pcm)
        assertEquals("RIFF", wav.copyOfRange(0, 4).toString(Charsets.US_ASCII))
        val header = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(40, header.getInt(4)); assertEquals(16000, header.getInt(24))
        assertEquals(1.toShort(), header.getShort(22)); assertEquals(16.toShort(), header.getShort(34))
        assertEquals(pcm.size, header.getInt(40)); assertArrayEquals(pcm, wav.copyOfRange(44, wav.size))
    }

    @Test fun newBatchesSealCanonicalMillisecondsWithoutReencodingExistingFiles() {
        val store = store()
        val started = start.plusNanos(123456789)
        val journal = store.begin(id(), id(), started)
        assertEquals("2026-09-01T10:00:00.123Z", journal.startedAt)
        store.pcmFile(journal.batchId).writeBytes(ByteArray(32000)); store.seal(journal)
        val pending = store.pending().single()
        assertEquals("2026-09-01T10:00:00.123Z", pending.manifest.batch.items.single().startedAt)
        assertEquals("2026-09-01T10:00:01.123Z", pending.manifest.batch.items.single().endedAt)
        // Simulate an earlier release's already sealed bytes. Loading/retry must
        // retain that representation and checksum, never silently normalize it.
        val legacy = pending.bytes.toString(Charsets.UTF_8).replace("00.123Z", "00.123456789Z").toByteArray()
        val file = File(store.directory, "${journal.batchId}.batch.json")
        file.writeBytes(legacy)
        val reloaded = store.pending().single()
        assertArrayEquals(legacy, reloaded.bytes)
        assertEquals(sha256(legacy), reloaded.manifest.sha256)
        assertArrayEquals(legacy, file.readBytes())
    }

    @Test fun locationSpansAreFreshClippedBoundedAndContainNoCoordinates() {
        val history = EchoLocationHistory()
        history.add(PlaceFix(start, 20.0, "San Francisco", "United States", "Sunset"), start)
        history.pause(start.plusSeconds(10))
        history.add(PlaceFix(start.plusSeconds(20), 800.0, "San Francisco", "United States", "Sunset"), start.plusSeconds(20))
        val spans = history.spans(start.plusSeconds(5), start.plusSeconds(200))
        assertEquals(2, spans.size)
        assertEquals(wireTimestamp(start.plusSeconds(5)), spans[0].jsonObject["from"]!!.jsonPrimitive.content)
        assertEquals(wireTimestamp(start.plusSeconds(10)), spans[0].jsonObject["to"]!!.jsonPrimitive.content)
        assertEquals(wireTimestamp(start.plusSeconds(140)), spans[1].jsonObject["to"]!!.jsonPrimitive.content)
        assertEquals("city", spans[1].jsonObject["granularity"]!!.jsonPrimitive.content)
        assertNull(spans[1].jsonObject["district"])
        assertFalse(spans.toString().contains("latitude")); assertFalse(spans.toString().contains("longitude"))
    }

    @Test fun invalidFutureAndOutOfOrderPlacesStayUnknown() {
        val history = EchoLocationHistory()
        for (fix in listOf(PlaceFix(start.plusSeconds(1), 1.0, "City", "Country"),
            PlaceFix(start.minusSeconds(121), 1.0, "City", "Country"), PlaceFix(start, Double.NaN, "City", "Country"),
            PlaceFix(start, 5001.0, "City", "Country"), PlaceFix(start, 1.0, "\u0000", "Country"))) history.add(fix, start)
        assertTrue(history.spans(start, start.plusSeconds(100)).isEmpty())
        history.add(PlaceFix(start, 1.0, "City", "Country"), start)
        history.add(PlaceFix(start.minusSeconds(1), 1.0, "Wrong", "Country"), start)
        assertEquals(1, history.spans(start, start.plusSeconds(100)).size)
    }
}
