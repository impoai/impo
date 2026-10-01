package ai.impo.nativebridge

import android.content.Context
import android.media.MediaMetadataRetriever
import android.media.MediaRecorder
import android.os.Build
import kotlinx.coroutines.*
import java.io.File
import kotlin.math.log10

class AndroidVoiceRecorderFactory(context: Context) : VoiceRecorderFactory {
    private val context = context.applicationContext
    override fun create(listener: (VoiceCaptureEvent) -> Unit): VoiceRecorder = AndroidVoiceRecorder(context, listener)
}

/** Native AAC capture; it needs only Microphone permission, never a speech recognition service. */
internal class AndroidVoiceRecorder(
    private val context: Context,
    private val listener: (VoiceCaptureEvent) -> Unit,
) : VoiceRecorder {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val files = VoiceCaptureFiles(File(context.cacheDir, "voice-composer"))
    private val file = files.create()
    private var recorder: MediaRecorder? = null
    private var started = false
    private var finished = false
    private var reachedLimit = false
    private var meter: Job? = null

    override fun start() {
        check(!started && !finished)
        @Suppress("DEPRECATION")
        val capture = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else MediaRecorder()
        recorder = capture
        capture.setAudioSource(MediaRecorder.AudioSource.MIC)
        capture.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        capture.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        capture.setAudioSamplingRate(16_000)
        capture.setAudioChannels(1)
        capture.setAudioEncodingBitRate(24_000)
        // Reserve AAC frame/muxer headroom, and validate the final duration and byte count below.
        capture.setMaxDuration((RecordedVoiceClip.MAX_DURATION_MILLIS - 256).toInt())
        capture.setMaxFileSize(RecordedVoiceClip.MAX_BYTES - 64 * 1024L)
        capture.setOutputFile(file.absolutePath)
        capture.setOnInfoListener { _, what, _ ->
            if (!finished && what in setOf(MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED, MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED)) {
                reachedLimit = true
                listener(VoiceCaptureEvent.LimitReached)
            }
        }
        capture.setOnErrorListener { _, _, _ ->
            if (!finished) listener(VoiceCaptureEvent.Failure("The microphone was interrupted. Hold again to try once more."))
        }
        capture.prepare()
        capture.start()
        started = true
        listener(VoiceCaptureEvent.Ready)
        meter = scope.launch {
            while (isActive && !finished) {
                delay(50)
                val amplitude = runCatching { capture.maxAmplitude }.getOrDefault(0)
                val decibels = 20 * log10((amplitude / 32768.0).coerceAtLeast(0.00001))
                listener(VoiceCaptureEvent.Level(((decibels + 50) / 40).toFloat().coerceIn(0f, 1f)))
            }
        }
    }

    override fun finish(): VoiceRecording? {
        if (finished) return null
        finished = true
        meter?.cancel(); meter = null
        val capture = recorder; recorder = null
        try {
            var validStop = started
            try {
                if (started) capture?.stop()
            } catch (_: RuntimeException) {
                // Max-size/duration callbacks may arrive after MediaRecorder has already stopped.
                validStop = reachedLimit
            } finally {
                runCatching { capture?.release() }
                scope.cancel()
            }
            if (!validStop || file.length() == 0L) return null
            require(file.length() <= RecordedVoiceClip.MAX_BYTES) { "Voice recording exceeds the upload limit." }
            val metadata = MediaMetadataRetriever()
            val duration = try {
                metadata.setDataSource(file.absolutePath)
                require(metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes") { "Voice recording contains no audio." }
                requireNotNull(metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull())
            } finally { metadata.release() }
            require(duration in 1..RecordedVoiceClip.MAX_DURATION_MILLIS) { "Voice recording exceeds two minutes." }
            return VoiceRecording(files.consume(file), duration)
        } finally { files.discard(file) }
    }

    override fun close() {
        finished = true
        meter?.cancel(); meter = null
        val capture = recorder; recorder = null
        try { if (started) runCatching { capture?.stop() } }
        finally { runCatching { capture?.release() }; scope.cancel(); files.discard(file) }
    }
}
