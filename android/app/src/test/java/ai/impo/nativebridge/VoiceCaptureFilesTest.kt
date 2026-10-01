package ai.impo.nativebridge

import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class VoiceCaptureFilesTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun clipDefensivelyCopiesBothInputAndOutputBytes() {
        val bytes = byteArrayOf(3, 2, 1)
        val clip = RecordedVoiceClip.fromBytes(bytes)
        bytes[0] = 9; clip.bytes()[1] = 9
        assertArrayEquals(byteArrayOf(3, 2, 1), clip.bytes())
        assertEquals("audio/mp4", clip.mimeType)
        assertEquals(3, clip.byteLength)
        assertThrows(IllegalArgumentException::class.java) { RecordedVoiceClip.fromBytes(byteArrayOf()) }
        assertThrows(IllegalArgumentException::class.java) { RecordedVoiceClip.fromBytes(ByteArray(RecordedVoiceClip.MAX_BYTES + 1)) }
    }

    @Test fun successfulFinalizationReturnsExactBytesAndDeletesThePrivateFile() {
        val store = VoiceCaptureFiles(temporary.newFolder())
        val file = store.create(); val bytes = ByteArray(48_000) { (it % 251).toByte() }; file.writeBytes(bytes)
        val clip = store.consume(file)
        assertFalse(file.exists()); assertArrayEquals(bytes, clip.bytes())
    }

    @Test fun failedFinalizationStillDeletesEmptyAndOversizedFiles() {
        val store = VoiceCaptureFiles(temporary.newFolder())
        listOf(0, RecordedVoiceClip.MAX_BYTES + 1).forEach { size ->
            val file = store.create(); file.writeBytes(ByteArray(size))
            assertThrows(IllegalArgumentException::class.java) { store.consume(file) }
            assertFalse(file.exists())
        }
    }

    @Test fun cancellationRemovesFileAndTheNextCaptureReapsOnlyAbandonedCaptures() {
        val directory = temporary.newFolder()
        val store = VoiceCaptureFiles(directory)
        val active = store.create(); active.writeBytes(byteArrayOf(1))
        val orphan = File(directory, "voice-process-death.m4a"); orphan.writeBytes(byteArrayOf(2))
        val unrelated = File(directory, "other-cache-file"); unrelated.writeBytes(byteArrayOf(3))
        val next = VoiceCaptureFiles(directory).create()
        assertTrue(active.exists()); assertFalse(orphan.exists()); assertTrue(unrelated.exists())
        store.discard(active); store.discard(next)
        assertFalse(active.exists()); assertFalse(next.exists())
    }
}
