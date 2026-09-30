package ai.impo.nativebridge

import android.content.Context
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.FloatBuffer
import java.nio.LongBuffer

/** Official Silero v6 model: 16 kHz, 512 samples plus 64 context, [2,1,128] state. */
internal class SileroVad(context: Context) : AutoCloseable {
    private val environment = OrtEnvironment.getEnvironment()
    private val session = OrtSession.SessionOptions().use { options ->
        options.setIntraOpNumThreads(1)
        options.setInterOpNumThreads(1)
        options.addConfigEntry("session.intra_op.allow_spinning", "0")
        context.assets.open("SileroVAD/silero_vad.onnx").use { model ->
            environment.createSession(model.readBytes(), options)
        }
    }
    private var state = FloatArray(256)
    private var previous = FloatArray(64)

    fun probability(samples: ShortArray): Float {
        require(samples.size in 1..512)
        val input = FloatArray(576)
        previous.copyInto(input)
        samples.forEachIndexed { index, sample -> input[index + 64] = sample.toFloat() / 32768f }
        OnnxTensor.createTensor(environment, FloatBuffer.wrap(input), longArrayOf(1, 576)).use { audio ->
            OnnxTensor.createTensor(environment, FloatBuffer.wrap(state), longArrayOf(2, 1, 128)).use { memory ->
                OnnxTensor.createTensor(environment, LongBuffer.wrap(longArrayOf(16000)), longArrayOf(1)).use { rate ->
                    session.run(mapOf("input" to audio, "state" to memory, "sr" to rate)).use { result ->
                        val probability = (result.get("output").get() as OnnxTensor).floatBuffer.get()
                        require(probability.isFinite() && probability in 0f..1f) { "Invalid speech detector output" }
                        val next = (result.get("stateN").get() as OnnxTensor).floatBuffer
                        require(next.remaining() == 256)
                        next.get(state)
                        previous = input.copyOfRange(512, 576)
                        return probability
                    }
                }
            }
        }
    }

    override fun close() { session.close() }
}
