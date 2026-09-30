package ai.impo.nativebridge

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import ai.impo.client.ImpoClient
import java.io.File
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

data class NativeAccount(val accountId: String, val api: ImpoClient)
data class EchoRecordingState(
    val status: String = "stopped", val level: Float = 0f, val speech: Boolean = false,
    val message: String? = null, val pendingBatches: Int = 0,
) { val isRecording get() = status == "recording"; val isPaused get() = status == "paused" }

/** Recovery may finish after recording starts, or after the same account signs in again. */
internal class EchoRecoveryState(private val state: MutableStateFlow<EchoRecordingState>) {
    internal data class Ticket(val accountId: String, val generation: Long)
    private var accountId: String? = null
    private var generation = 0L

    @Synchronized fun begin(nextAccountId: String?): Ticket? {
        if (nextAccountId == accountId) return null
        accountId = nextAccountId
        generation += 1
        state.value = EchoRecordingState()
        return nextAccountId?.let { Ticket(it, generation) }
    }

    @Synchronized fun complete(ticket: Ticket, currentAccountId: String?, pendingBatches: Int, message: String?): Boolean {
        if (ticket.generation != generation || ticket.accountId != accountId || ticket.accountId != currentAccountId) return false
        state.update { current -> current.copy(pendingBatches = pendingBatches, message = current.message ?: message) }
        return true
    }
}

/** The Application installs an account-bound client provider, also used by restarted workers. */
object NativeBridge {
    @Volatile private var provider: () -> NativeAccount? = { null }
    private lateinit var application: Context
    internal val mutableRecording = MutableStateFlow(EchoRecordingState())
    val recording: StateFlow<EchoRecordingState> = mutableRecording
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val recovery = EchoRecoveryState(mutableRecording)

    fun install(context: Context, accountProvider: () -> NativeAccount?) {
        application = context.applicationContext; provider = accountProvider
        EchoUploadWorker.scheduleMaintenance(application)
    }
    internal fun account() = provider()
    internal fun store(context: Context, accountId: String) = EchoBatchStore(File(context.filesDir, "echo"), accountId)

    /** Invoke after restoring or switching identity. Recovery never restarts the microphone. */
    fun accountChanged(context: Context) {
        val current = account()
        EchoRecordingService.accountChanged()
        val ticket = recovery.begin(current?.accountId) ?: return
        scope.launch {
            val store = store(context, ticket.accountId)
            val errors = store.recover()
            if (recovery.complete(ticket, account()?.accountId, store.pendingCount(), errors.firstOrNull())) {
                EchoUploadWorker.enqueue(context, ticket.accountId)
            }
        }
    }

    fun startEcho(context: Context, includeLocation: Boolean = false) {
        if (account() == null) { mutableRecording.value = EchoRecordingState(message = "Sign in to record Echo."); return }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            mutableRecording.value = EchoRecordingState(message = "Microphone permission is required to record."); return
        }
        sendStart(context, EchoRecordingService.ACTION_START, includeLocation)
    }
    fun resumeEcho(context: Context) = sendStart(context, EchoRecordingService.ACTION_RESUME, null)
    fun pauseEcho(context: Context) { EchoRecordingService.control(EchoRecordingService.ACTION_PAUSE) }
    fun stopEcho(context: Context) {
        if (!EchoRecordingService.control(EchoRecordingService.ACTION_STOP))
            mutableRecording.value = recording.value.copy(status = "stopped", level = 0f, speech = false)
    }
    private fun sendStart(context: Context, action: String, location: Boolean?) {
        runCatching {
            val intent = Intent(context, EchoRecordingService::class.java).setAction(action)
            location?.let { intent.putExtra("includeLocation", it) }
            ContextCompat.startForegroundService(context, intent)
        }.onFailure { mutableRecording.value = recording.value.copy(status = "paused", message = "Couldn't start the microphone. Open Impo and try again.") }
    }
    fun wifiOnly(context: Context): Boolean = context.getSharedPreferences("native_preferences", Context.MODE_PRIVATE)
        .getBoolean("wifi_${account()?.accountId?.let { sha256(it.toByteArray()) }}", false)
    fun setWifiOnly(context: Context, enabled: Boolean) {
        val accountId = account()?.accountId ?: return
        context.getSharedPreferences("native_preferences", Context.MODE_PRIVATE).edit()
            .putBoolean("wifi_${sha256(accountId.toByteArray())}", enabled).apply()
        EchoUploadWorker.enqueue(context, accountId, replace = true)
    }
    fun retryUploads(context: Context) { account()?.let { EchoUploadWorker.enqueue(context, it.accountId, replace = true) } }
    fun setRecordingLocation(context: Context, enabled: Boolean) {
        val id = account()?.accountId ?: return
        context.getSharedPreferences("native_preferences", Context.MODE_PRIVATE).edit()
            .putBoolean("location_${sha256(id.toByteArray())}", enabled).apply()
        if (!enabled) EchoRecordingService.disableLocation()
    }
    internal fun refreshPending(context: Context, accountId: String) {
        val count = store(context, accountId).pendingCount()
        if (account()?.accountId == accountId) mutableRecording.update { it.copy(pendingBatches = count) }
    }
}
