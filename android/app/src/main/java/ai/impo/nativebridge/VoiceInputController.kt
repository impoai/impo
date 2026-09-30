package ai.impo.nativebridge

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class VoicePhase { Idle, Starting, Listening, Finishing }
data class VoiceInputState(
    val phase: VoicePhase = VoicePhase.Idle,
    val transcript: String = "",
    val levels: List<Float> = List(40) { 0f },
    val cancelArmed: Boolean = false,
    val message: String? = null,
    val onDevice: Boolean = false,
) { val active: Boolean get() = phase != VoicePhase.Idle }

sealed interface VoiceRecognitionEvent {
    data object Ready : VoiceRecognitionEvent
    data class Partial(val text: String) : VoiceRecognitionEvent
    data class Final(val text: String) : VoiceRecognitionEvent
    data class Level(val value: Float) : VoiceRecognitionEvent
    data class Failure(val message: String) : VoiceRecognitionEvent
}
interface VoiceRecognizer {
    val onDevice: Boolean
    fun start()
    fun finish()
    fun close()
}
fun interface VoiceRecognizerFactory {
    fun create(listener: (VoiceRecognitionEvent) -> Unit): VoiceRecognizer
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

/** Main-thread coordinator. Every callback is tied to a single hold and invalidated before send. */
class VoiceInputController(
    private val scope: CoroutineScope,
    private val factory: VoiceRecognizerFactory,
    private val startBlocked: () -> String? = { null },
    private val onTranscript: (String) -> Unit,
) {
    private val mutable = MutableStateFlow(VoiceInputState())
    val state = mutable.asStateFlow()
    private var generation = 0L
    private var recognizer: VoiceRecognizer? = null
    private var timeout: Job? = null
    private var finalReceived = false
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
        finalReceived = false
        mutable.value = VoiceInputState(phase = VoicePhase.Starting)
        try {
            val engine = factory.create { event -> scope.launch { receive(token, event) } }
            recognizer = engine
            mutable.value = state.value.copy(onDevice = engine.onDevice)
            engine.start()
            timeout = scope.launch { delay(60_000); if (generation == token) this@VoiceInputController.cancel("Voice input stopped after one minute. Hold again to continue.") }
        } catch (failure: Exception) {
            cancel(failure.message ?: "Speech recognition isn't available. Try typing instead.")
        }
    }

    fun move(cancelArmed: Boolean) {
        if (state.value.phase in setOf(VoicePhase.Starting, VoicePhase.Listening)) mutable.value = state.value.copy(cancelArmed = cancelArmed)
    }

    fun finish() {
        if (disposed || state.value.phase !in setOf(VoicePhase.Starting, VoicePhase.Listening)) return
        if (state.value.cancelArmed) { cancel(); return }
        startBlocked()?.let { cancel(it); return }
        timeout?.cancel()
        mutable.value = state.value.copy(phase = VoicePhase.Finishing)
        if (finalReceived) { deliver(); return }
        val token = generation
        try { recognizer?.finish() } catch (_: Exception) { cancel("Couldn't finish voice input. Please try again."); return }
        timeout = scope.launch {
            delay(3_000)
            if (generation == token && state.value.phase == VoicePhase.Finishing) deliver()
        }
    }

    /** The permission prompt consumes this hold. Its result can never begin microphone capture. */
    fun permissionRequested(): Long { cancel(); pendingPermission = generation; return generation }
    fun permissionResult(ticket: Long, granted: Boolean) {
        // Android may cancel the pointer gesture or stop the Activity while its dialog is open.
        // Keep the explanatory result, but a new hold or disposed composer invalidates it.
        if (!disposed && pendingPermission == ticket && !state.value.active) {
            pendingPermission = null
            notice(if (granted) "You're all set. Hold the empty input again to talk." else "Allow Microphone access in Android settings to talk to Impo.")
        }
    }

    fun notice(message: String) { if (!disposed && !state.value.active) mutable.value = state.value.copy(message = message) }
    fun cancel(message: String? = null) {
        generation += 1
        closeRecognizer()
        timeout?.cancel(); timeout = null
        finalReceived = false
        mutable.value = VoiceInputState(message = message)
    }
    fun close() { cancel(); pendingPermission = null; disposed = true }

    private fun receive(token: Long, event: VoiceRecognitionEvent) {
        if (disposed || generation != token || !state.value.active) return
        startBlocked()?.let { cancel(it); return }
        when (event) {
            VoiceRecognitionEvent.Ready -> if (state.value.phase == VoicePhase.Starting) mutable.value = state.value.copy(phase = VoicePhase.Listening)
            is VoiceRecognitionEvent.Partial -> if (!finalReceived) mutable.value = state.value.copy(transcript = event.text.take(32768))
            is VoiceRecognitionEvent.Level -> if (state.value.phase != VoicePhase.Finishing && event.value.isFinite())
                mutable.value = state.value.copy(levels = state.value.levels.drop(1) + event.value.coerceIn(0f, 1f))
            is VoiceRecognitionEvent.Final -> {
                if (finalReceived) return
                finalReceived = true
                mutable.value = state.value.copy(transcript = event.text.take(32768))
                closeRecognizer()
                if (state.value.phase == VoicePhase.Finishing) deliver()
            }
            is VoiceRecognitionEvent.Failure -> if (!finalReceived) cancel(event.message)
        }
    }

    private fun deliver() {
        startBlocked()?.let { cancel(it); return }
        val text = state.value.transcript.trim()
        // Invalidating callbacks and releasing capture precede the side effect, including reentrant sends.
        cancel(if (text.isEmpty()) "No speech was recognized. Hold again or type your message." else null)
        if (text.isNotEmpty() && !disposed) onTranscript(text)
    }
    private fun closeRecognizer() {
        val old = recognizer; recognizer = null
        runCatching { old?.close() }
        lease?.let(VoiceMicrophone::release); lease = null
    }
}
