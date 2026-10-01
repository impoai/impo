package ai.impo.nativebridge

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** A private, immutable AAC/MP4 capture. Server protocol encoding belongs to the client layer. */
class RecordedVoiceClip private constructor(private val audio: ByteArray) {
    val mimeType: String get() = "audio/mp4"
    val byteLength: Int get() = audio.size
    fun bytes(): ByteArray = audio.copyOf()

    companion object {
        const val MAX_BYTES = 2 * 1024 * 1024
        const val MAX_DURATION_MILLIS = 120_000L
        const val MIN_DURATION_MILLIS = 400L
        fun fromBytes(bytes: ByteArray): RecordedVoiceClip {
            require(bytes.isNotEmpty() && bytes.size <= MAX_BYTES) { "Voice recording must be between 1 byte and 2 MiB." }
            return RecordedVoiceClip(bytes.copyOf())
        }
    }
}

enum class VoicePhase { Idle, Starting, Recording, Finishing }
data class VoiceInputState(
    val phase: VoicePhase = VoicePhase.Idle,
    val levels: List<Float> = List(40) { 0f },
    val cancelArmed: Boolean = false,
    val message: String? = null,
    val limitReached: Boolean = false,
) { val active: Boolean get() = phase != VoicePhase.Idle }

sealed interface VoiceCaptureEvent {
    data object Ready : VoiceCaptureEvent
    data object LimitReached : VoiceCaptureEvent
    data class Level(val value: Float) : VoiceCaptureEvent
    data class Failure(val message: String) : VoiceCaptureEvent
}
data class VoiceRecording(val clip: RecordedVoiceClip, val durationMillis: Long)
interface VoiceRecorder {
    fun start()
    /** Stops capture, releases native resources, and removes the temporary file before returning. */
    fun finish(): VoiceRecording?
    fun close()
}
fun interface VoiceRecorderFactory {
    fun create(listener: (VoiceCaptureEvent) -> Unit): VoiceRecorder
}

/** Shared with Echo's user-started service so two capture paths do not compete. */
object VoiceMicrophone {
    private var owner: Any? = null
    private val mutable = MutableStateFlow(false)
    val inUse: StateFlow<Boolean> = mutable.asStateFlow()
    @Synchronized internal fun acquire(token: Any): Boolean {
        if (owner != null) return false
        owner = token; mutable.value = true; return true
    }
    @Synchronized internal fun release(token: Any) {
        if (owner === token) { owner = null; mutable.value = false }
    }
}

/** Main-thread hold coordinator. Emitted clips belong to the caller, never to this lifecycle. */
class VoiceInputController(
    private val scope: CoroutineScope,
    private val factory: VoiceRecorderFactory,
    private val startBlocked: () -> String? = { null },
    private val onClip: (RecordedVoiceClip) -> Unit,
) {
    private val mutable = MutableStateFlow(VoiceInputState())
    val state = mutable.asStateFlow()
    private var generation = 0L
    private var recorder: VoiceRecorder? = null
    private var timeout: Job? = null
    private var heldRecording: VoiceRecording? = null
    private var peakLevel = 0f
    private var disposed = false
    private var lease: Any? = null
    private var pendingPermission: Long? = null

    fun begin() {
        if (disposed || state.value.active) return
        pendingPermission = null
        startBlocked()?.let { notice(it); return }
        val token = ++generation
        val ownership = Any()
        if (!VoiceMicrophone.acquire(ownership)) { notice("Another voice input is using the microphone."); return }
        lease = ownership
        peakLevel = 0f
        heldRecording = null
        mutable.value = VoiceInputState(phase = VoicePhase.Starting)
        try {
            val engine = factory.create { event -> scope.launch { receive(token, event) } }
            recorder = engine
            engine.start()
            // Native encoder limits also apply. The timer releases capture without auto-submitting.
            if (generation == token && state.value.active && !state.value.limitReached) {
                timeout = scope.launch {
                    delay(RecordedVoiceClip.MAX_DURATION_MILLIS)
                    if (generation == token) freezeAtLimit()
                }
            }
        } catch (_: Exception) {
            cancel("Couldn't start the microphone. Check Microphone access and try again.")
        }
    }

    fun move(cancelArmed: Boolean) {
        if (state.value.phase in setOf(VoicePhase.Starting, VoicePhase.Recording))
            mutable.value = state.value.copy(cancelArmed = cancelArmed)
    }

    fun finish() {
        if (disposed || state.value.phase !in setOf(VoicePhase.Starting, VoicePhase.Recording)) return
        if (state.value.cancelArmed) { cancel(); return }
        startBlocked()?.let { cancel(it); return }
        timeout?.cancel(); timeout = null
        val token = generation
        val frozen = state.value.limitReached
        mutable.value = state.value.copy(phase = VoicePhase.Finishing)
        val recording = if (frozen) heldRecording else stopRecording()
        if (generation != token || disposed) return
        startBlocked()?.let { cancel(it); return }
        val usable = recording != null && recording.durationMillis in
            RecordedVoiceClip.MIN_DURATION_MILLIS..RecordedVoiceClip.MAX_DURATION_MILLIS && peakLevel >= 0.15f
        // Invalidate callbacks and release ownership before a possibly reentrant server submission.
        cancel(if (usable) null else "Didn't catch that. Hold the input while you speak, then release.")
        if (usable && !disposed) onClip(recording!!.clip)
    }

    /** The permission prompt consumes this hold. Its result can never begin microphone capture. */
    fun permissionRequested(): Long { cancel(); pendingPermission = generation; return generation }
    fun permissionResult(ticket: Long, granted: Boolean) {
        // Android can cancel the pointer gesture or stop the Activity while its dialog is open.
        if (!disposed && pendingPermission == ticket && !state.value.active) {
            pendingPermission = null
            notice(if (granted) "You're all set. Hold the empty input again to talk." else "Allow Microphone access in Android settings to talk to Impo.")
        }
    }

    fun notice(message: String) { if (!disposed && !state.value.active) mutable.value = state.value.copy(message = message) }
    fun cancel(message: String? = null) {
        generation += 1
        closeRecorder()
        timeout?.cancel(); timeout = null
        heldRecording = null
        peakLevel = 0f
        mutable.value = VoiceInputState(message = message)
    }
    fun close() { cancel(); pendingPermission = null; disposed = true }

    private fun receive(token: Long, event: VoiceCaptureEvent) {
        if (disposed || generation != token || !state.value.active || state.value.limitReached) return
        startBlocked()?.let { cancel(it); return }
        when (event) {
            VoiceCaptureEvent.Ready -> if (state.value.phase == VoicePhase.Starting)
                mutable.value = state.value.copy(phase = VoicePhase.Recording)
            is VoiceCaptureEvent.Level -> if (state.value.phase != VoicePhase.Finishing && event.value.isFinite()) {
                val level = event.value.coerceIn(0f, 1f)
                peakLevel = maxOf(peakLevel, level)
                mutable.value = state.value.copy(levels = state.value.levels.drop(1) + level)
            }
            VoiceCaptureEvent.LimitReached -> freezeAtLimit()
            is VoiceCaptureEvent.Failure -> cancel(event.message)
        }
    }

    private fun freezeAtLimit() {
        if (!state.value.active || state.value.limitReached || disposed) return
        startBlocked()?.let { cancel(it); return }
        val token = generation
        mutable.value = state.value.copy(limitReached = true)
        timeout?.cancel(); timeout = null
        val recording = stopRecording()
        if (generation == token && !disposed) heldRecording = recording
    }

    private fun stopRecording(): VoiceRecording? {
        val old = recorder; recorder = null
        return try { old?.finish() }
        catch (_: Exception) { cancel("Couldn't finish voice input. Hold again to try once more."); null }
        finally {
            runCatching { old?.close() }
            releaseLease()
        }
    }
    private fun closeRecorder() {
        val old = recorder; recorder = null
        runCatching { old?.close() }
        releaseLease()
    }
    private fun releaseLease() { lease?.let(VoiceMicrophone::release); lease = null }
}
