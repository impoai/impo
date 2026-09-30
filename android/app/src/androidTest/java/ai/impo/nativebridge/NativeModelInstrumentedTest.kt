package ai.impo.nativebridge

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeModelInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test fun bundledOnnxMatchesIosModelAndRejectsSilence() {
        val model = instrumentation.targetContext.assets.open("SileroVAD/silero_vad.onnx").use { it.readBytes() }
        assertEquals("1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3", sha256(model))
        assertFalse(detect(ShortArray(16000 * 4)))
    }

    @Test fun actualNativeModelRecognizesEnglishAndMandarinWithFreshState() {
        assertTrue("English speech must trigger the real model", detect(fixture("speech-en.wav")))
        assertTrue("Mandarin speech must trigger the real model", detect(fixture("speech-zh.wav")))
        assertFalse("The next recording must start with clean model state", detect(ShortArray(16000 * 2)))
    }

    private fun detect(samples: ShortArray): Boolean {
        val segmenter = SpeechSegmenter()
        var detected = false
        SileroVad(instrumentation.targetContext).use { vad ->
            var offset = 0
            while (offset < samples.size) {
                val frame = samples.copyOfRange(offset, minOf(offset + 512, samples.size))
                val probability = vad.probability(frame)
                assertTrue(probability.isFinite() && probability in 0f..1f)
                if (segmenter.consume(frame, probability).any { it is SpeechSegmenter.Event.Begin }) detected = true
                offset += frame.size
            }
        }
        return detected
    }

    private fun fixture(name: String): ShortArray {
        val bytes = instrumentation.context.assets.open(name).use { it.readBytes() }
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals("RIFF", bytes.copyOfRange(0, 4).toString(Charsets.US_ASCII))
        var offset = 12
        var format = 0; var bits = 0; var sampleRate = 0; var channels = 0
        var pcm: ByteArray? = null
        while (offset + 8 <= bytes.size) {
            val id = bytes.copyOfRange(offset, offset + 4).toString(Charsets.US_ASCII)
            val size = buffer.getInt(offset + 4)
            require(size >= 0 && offset + 8 + size <= bytes.size)
            if (id == "fmt ") {
                format = buffer.getShort(offset + 8).toInt(); channels = buffer.getShort(offset + 10).toInt()
                sampleRate = buffer.getInt(offset + 12); bits = buffer.getShort(offset + 22).toInt()
            }
            if (id == "data") pcm = bytes.copyOfRange(offset + 8, offset + 8 + size)
            offset += 8 + size + size % 2
        }
        assertEquals(1, format); assertEquals(16, bits); assertEquals(16000, sampleRate); assertEquals(1, channels)
        val raw = ByteBuffer.wrap(checkNotNull(pcm)).order(ByteOrder.LITTLE_ENDIAN)
        return ShortArray(raw.remaining() / 2) { raw.short }
    }
}
