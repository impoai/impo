package ai.impo.nativebridge

import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID

/** Private cache files only. A subsequent capture reaps leftovers from process death. */
internal class VoiceCaptureFiles(private val directory: File) {
    fun create(): File = synchronized(active) {
        check(directory.isDirectory || directory.mkdirs()) { "Voice capture storage is unavailable." }
        directory.listFiles()?.filter { it.name.startsWith("voice-") && it.extension == "m4a" && it.absolutePath !in active }
            ?.forEach(File::delete)
        File(directory, "voice-${UUID.randomUUID()}.m4a").also { active.add(it.absolutePath) }
    }

    fun consume(file: File): RecordedVoiceClip {
        try {
            require(file.length() in 1L..RecordedVoiceClip.MAX_BYTES.toLong()) { "Voice recording exceeds the upload limit." }
            val bytes = ByteArrayOutputStream()
            file.inputStream().use { input ->
                val chunk = ByteArray(16 * 1024)
                while (true) {
                    val count = input.read(chunk)
                    if (count < 0) break
                    require(bytes.size().toLong() + count <= RecordedVoiceClip.MAX_BYTES) { "Voice recording exceeds the upload limit." }
                    bytes.write(chunk, 0, count)
                }
            }
            return RecordedVoiceClip.fromBytes(bytes.toByteArray())
        } finally { discard(file) }
    }

    fun discard(file: File) = synchronized(active) { file.delete(); active.remove(file.absolutePath); Unit }

    private companion object { val active = mutableSetOf<String>() }
}
