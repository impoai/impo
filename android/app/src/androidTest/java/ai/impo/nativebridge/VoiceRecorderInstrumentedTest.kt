package ai.impo.nativebridge

import android.Manifest
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Real MediaRecorder/codec coverage. Emulator silence is valid encoded audio, not an ASR claim. */
@RunWith(AndroidJUnit4::class)
class VoiceRecorderInstrumentedTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext

    @Before fun permitForegroundMicrophone() {
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.RECORD_AUDIO)
        compose.setContent { }
        compose.waitForIdle()
    }

    @Test fun actualRecorderProducesBoundedMono16kAacMp4AndRemovesTemporaryCapture() {
        val events = CopyOnWriteArrayList<VoiceCaptureEvent>()
        lateinit var recorder: VoiceRecorder
        var result: VoiceRecording? = null
        instrumentation.runOnMainSync { recorder = AndroidVoiceRecorderFactory(context).create(events::add); recorder.start() }
        try {
            SystemClock.sleep(1_000)
            instrumentation.runOnMainSync { result = recorder.finish() }
            val recording = requireNotNull(result)
            assertTrue(events.contains(VoiceCaptureEvent.Ready))
            assertTrue(events.any { it is VoiceCaptureEvent.Level })
            assertFalse(events.any { it is VoiceCaptureEvent.Failure })
            assertEquals("audio/mp4", recording.clip.mimeType)
            assertTrue(recording.durationMillis in 400..RecordedVoiceClip.MAX_DURATION_MILLIS)
            assertTrue(recording.clip.byteLength in 1..RecordedVoiceClip.MAX_BYTES)
            assertNoCaptureFiles()
            val inspection = File.createTempFile("inspect-voice-", ".m4a", context.cacheDir)
            try {
                inspection.writeBytes(recording.clip.bytes())
                // ISO Base Media File Format identifies the actual container rather than its suffix.
                assertEquals("ftyp", recording.clip.bytes().copyOfRange(4, 8).toString(Charsets.US_ASCII))
                val extractor = MediaExtractor()
                try {
                    extractor.setDataSource(inspection.absolutePath)
                    assertEquals(1, extractor.trackCount)
                    val format = extractor.getTrackFormat(0)
                    assertEquals("audio/mp4a-latm", format.getString(MediaFormat.KEY_MIME))
                    assertEquals(16_000, format.getInteger(MediaFormat.KEY_SAMPLE_RATE))
                    assertEquals(1, format.getInteger(MediaFormat.KEY_CHANNEL_COUNT))
                } finally { extractor.release() }
            } finally { inspection.delete() }
        } finally { instrumentation.runOnMainSync { recorder.close() }; assertNoCaptureFiles() }
    }

    @Test fun actualRecorderCancellationDeletesAudioAndAllowsANewRecorderToStart() {
        repeat(2) {
            lateinit var recorder: VoiceRecorder
            instrumentation.runOnMainSync { recorder = AndroidVoiceRecorderFactory(context).create { }; recorder.start() }
            try { SystemClock.sleep(450) }
            finally { instrumentation.runOnMainSync { recorder.close() } }
            assertNoCaptureFiles()
        }
    }

    private fun assertNoCaptureFiles() {
        assertTrue(File(context.cacheDir, "voice-composer").listFiles().orEmpty().none { it.name.startsWith("voice-") })
    }
}
