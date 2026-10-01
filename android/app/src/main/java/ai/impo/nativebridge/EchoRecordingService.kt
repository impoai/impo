package ai.impo.nativebridge

import android.Manifest
import android.app.*
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.*
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.time.Instant
import java.util.UUID
import kotlin.math.sqrt
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Explicit user-started foreground capture. START_NOT_STICKY prevents surprise microphone restarts. */
class EchoRecordingService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val transition = Mutex()
    private var capture: Job? = null
    private val deadline = EchoStopDeadline()
    private var stopTimer: Job? = null
    private var closing = false
    private var owner: NativeAccount? = null
    private var streamId = UUID.randomUUID().toString()
    private var sessionId = UUID.randomUUID().toString()
    @Volatile private var includeLocation = false
    @Volatile private var recorder: AudioRecord? = null
    @Volatile private var activeLocation: RecordingLocation? = null

    override fun onCreate() {
        super.onCreate()
        activeService = java.lang.ref.WeakReference(this)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Echo recording", NotificationManager.IMPORTANCE_LOW)
                .apply { description = "Controls for the Echo recording you started"; setSound(null, null) })
    }
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        if (closing) return START_NOT_STICKY
        val commandAccount = NativeBridge.account()
        if (action in setOf(ACTION_START, ACTION_RESUME, ACTION_PAUSE, ACTION_STOP)) {
            val current = commandAccount
            if (current == null || !current.captureSession.accepts(intent?.getStringExtra(EXTRA_SESSION), current.captureSession)) {
                checkAccount()
                if (owner == null) stopSelf()
                return START_NOT_STICKY
            }
            if (owner != null && owner !== current) { checkAccount(); return START_NOT_STICKY }
        }
        when (action) {
            ACTION_START, ACTION_RESUME -> {
                if (VoiceMicrophone.inUse.value) {
                    NativeBridge.mutableRecording.value = NativeBridge.recording.value.copy(message = "Finish voice input before starting Echo.")
                    if (owner == null) stopSelf()
                    return START_NOT_STICKY
                }
                // The foreground deadline also applies while loading the on-device model.
                val account = NativeBridge.account()
                if (account == null || !hasMicrophonePermission()) {
                    NativeBridge.mutableRecording.value = NativeBridge.recording.value.copy(status = "stopped", message = "Sign in and allow microphone access to record.")
                    stopSelf(); return START_NOT_STICKY
                }
                if (owner != null && owner !== account) { checkAccount(); return START_NOT_STICKY }
                owner = account
                val settings = getSharedPreferences("native_preferences", MODE_PRIVATE)
                val locationKey = "location_${sha256(account.accountId.toByteArray())}"
                if (action == ACTION_START) {
                    includeLocation = intent.getBooleanExtra("includeLocation", false)
                    settings.edit().putBoolean(locationKey, includeLocation).apply()
                } else includeLocation = settings.getBoolean(locationKey, false)
                try {
                    val microphoneType = if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
                    val locationType = if (Build.VERSION.SDK_INT >= 29 && includeLocation && RecordingLocation.hasPermission(this))
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0
                    val types = microphoneType or locationType
                    if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification(false), types)
                    else startForeground(NOTIFICATION_ID, notification(false))
                } catch (_: Exception) {
                    NativeBridge.mutableRecording.value = NativeBridge.recording.value.copy(status = "paused", message = "Open Impo to resume microphone access.")
                    stopSelf(); return START_NOT_STICKY
                }
                scope.launch { transition.withLock {
                    if (closing) return@withLock
                    if (NativeBridge.account() !== account || owner !== account) { checkAccount(); return@withLock }
                    if (VoiceMicrophone.inUse.value) {
                        NativeBridge.mutableRecording.value = NativeBridge.recording.value.copy(message = "Finish voice input before starting Echo.")
                        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(true))
                        return@withLock
                    }
                    if (capture?.isActive == true) return@withLock
                    val saved = (application as ai.impo.ImpoApplication).settings.echoSchedule(account.accountId) ?: ai.impo.client.EchoSchedule()
                    if (NativeBridge.account() !== account || owner !== account) { checkAccount(); return@withLock }
                    deadline.start(saved, Instant.now())
                    if (deadline.expired()) { finishRecording(account, scheduled = true); return@withLock }
                    armStopTimer(account)
                    NativeBridge.mutableRecording.value = NativeBridge.recording.value.copy(status = "recording", message = null)
                    capture = scope.launch(Dispatchers.IO) { record(account) }
                } }
            }
            ACTION_PAUSE -> scope.launch { transition.withLock {
                if (closing) return@withLock
                if (NativeBridge.account() !== commandAccount || owner !== commandAccount) { checkAccount(); return@withLock }
                val previous = capture; stopCapture(); previous?.join(); capture = null
                if (NativeBridge.account() !== commandAccount) { checkAccount(); return@withLock }
                NativeBridge.mutableRecording.value = NativeBridge.recording.value.copy(status = "paused", level = 0f, speech = false)
                getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(true))
            } }
            ACTION_STOP -> scope.launch { transition.withLock {
                if (NativeBridge.account() !== commandAccount || owner !== commandAccount) { checkAccount(); return@withLock }
                finishRecording(commandAccount, scheduled = false)
            } }
            ACTION_ACCOUNT_CHANGED -> {
                checkAccount()
                if (owner == null) stopSelf()
            }
            else -> stopSelf()
        }
        return START_NOT_STICKY
    }

    @Suppress("MissingPermission")
    private suspend fun record(account: NativeAccount) {
        val accountId = account.accountId
        var audio: AudioRecord? = null
        var journal: SpeechJournalWriter? = null
        var vad: SileroVad? = null
        val wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "impo:echo")
            .apply { setReferenceCounted(false) }
        var renewedAt = 0L
        val segmenter = SpeechSegmenter()
        val places = EchoLocationHistory()
        val location = if (includeLocation && RecordingLocation.hasPermission(this)) RecordingLocation(this, places) else null
        activeLocation = location
        try {
            check(NativeBridge.account() === account) { "Recording account changed" }
            currentCoroutineContext().ensureActive()
            check(hasMicrophonePermission()) { "Microphone permission was removed" }
            val minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            check(minimum > 0) { "This microphone does not support 16 kHz audio" }
            audio = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
                .setAudioFormat(AudioFormat.Builder().setSampleRate(16000).setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(maxOf(minimum * 2, 16000 * 2)).build()
            check(audio.state == AudioRecord.STATE_INITIALIZED) { "Microphone initialization failed" }
            recorder = audio
            vad = SileroVad(this)
            val store = NativeBridge.store(this, accountId)
            // Any old journal belongs to a dead service, never this new capture.
            store.recover()
            // Identity replacement and microphone acquisition run on the same main dispatcher.
            // Model loading/recovery may have suspended long enough for this account to disappear.
            val initializedRecorder = audio
            withContext(Dispatchers.Main.immediate) {
                currentCoroutineContext().ensureActive()
                check(NativeBridge.account() === account && owner === account) { "Recording account changed" }
                check(!VoiceMicrophone.inUse.value) { "Finish voice input before starting Echo." }
                if (deadline.expired()) { requestScheduledStop(account); throw CancellationException("Scheduled stop") }
                initializedRecorder.startRecording()
            }
            check(audio.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Microphone is unavailable" }
            val startedAt = Instant.now()
            journal = SpeechJournalWriter(store, streamId, sessionId, startedAt, places) {
                NativeBridge.refreshPending(this, accountId); EchoUploadWorker.enqueue(this, accountId)
            }
            withContext(Dispatchers.Main) {
                if (includeLocation && activeLocation === location && NativeBridge.account() === account) location?.start()
                else location?.stop()
            }
            val frame = ShortArray(512)
            var count = 0
            var levelFrame = 0
            while (currentCoroutineContext().isActive && NativeBridge.account() === account) {
                if (deadline.expired()) { requestScheduledStop(account); break }
                if (android.os.SystemClock.elapsedRealtime() - renewedAt >= 5 * 60_000L || !wakeLock.isHeld) {
                    wakeLock.acquire(10 * 60_000L); renewedAt = android.os.SystemClock.elapsedRealtime()
                }
                check(hasMicrophonePermission()) { "Microphone permission was removed" }
                val read = audio.read(frame, count, frame.size - count, AudioRecord.READ_BLOCKING)
                if (NativeBridge.account() !== account || !currentCoroutineContext().isActive) break
                if (deadline.expired()) { requestScheduledStop(account); break }
                check(read > 0) { "Microphone was interrupted. Tap Resume to continue." }
                count += read
                if (count < frame.size) continue
                count = 0
                val probability = vad.probability(frame)
                segmenter.consume(frame.copyOf(), probability).forEach(journal::accept)
                if (++levelFrame % 4 == 0 && NativeBridge.account() === account) {
                    if (Build.VERSION.SDK_INT >= 29 && audio.activeRecordingConfiguration?.isClientSilenced == true) {
                        error("Microphone access was interrupted. Tap Resume when it is available.")
                    }
                    val rms = sqrt(frame.sumOf { val value = it.toDouble() / 32768; value * value } / frame.size).toFloat()
                    NativeBridge.mutableRecording.value = NativeBridge.recording.value.copy(level = (rms * 5).coerceIn(0f, 1f), speech = segmenter.isSpeaking)
                }
            }
        } catch (cancelled: CancellationException) { throw cancelled }
          catch (failure: Exception) {
            if (currentCoroutineContext().isActive && NativeBridge.account() === account) {
                NativeBridge.mutableRecording.value = NativeBridge.recording.value.copy(status = "paused", level = 0f, speech = false,
                    message = failure.message?.take(150) ?: "Microphone was interrupted. Tap Resume to continue.")
                getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(true))
            }
        } finally {
            runCatching { audio?.stop() }; audio?.release(); recorder = null
            location?.stop()
            if (activeLocation === location) activeLocation = null
            runCatching { segmenter.finish().forEach { journal?.accept(it) } }
            runCatching { journal?.close() }
                .onFailure { if (NativeBridge.account() === account) NativeBridge.mutableRecording.value = NativeBridge.recording.value.copy(message = "Audio remains saved for recovery on this device.") }
            runCatching { vad?.close() }
            runCatching { if (wakeLock.isHeld) wakeLock.release() }
            NativeBridge.refreshPending(this, accountId)
        }
    }

    private fun stopCapture() { capture?.cancel(); runCatching { recorder?.stop() } }
    private suspend fun finishRecording(account: NativeAccount?, scheduled: Boolean) {
        closing = true
        stopTimer?.cancel(); stopTimer = null
        val previous = capture; stopCapture(); previous?.join(); capture = null
        deadline.clear()
        if (NativeBridge.account() !== account) { checkAccount(); return }
        NativeBridge.mutableRecording.value = NativeBridge.recording.value.copy(status = "stopped", level = 0f, speech = false,
            scheduledStopAt = null, message = if (scheduled) "Echo stopped at your scheduled time." else null)
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }
    private fun requestScheduledStop(account: NativeAccount) {
        scope.launch { transition.withLock {
            if (owner === account && NativeBridge.account() === account && deadline.expired()) finishRecording(account, scheduled = true)
        } }
    }
    private fun armStopTimer(account: NativeAccount) {
        stopTimer?.cancel()
        NativeBridge.mutableRecording.value = NativeBridge.recording.value.copy(scheduledStopAt = deadline.stopAt)
        if (deadline.stopAt == null) return
        stopTimer = scope.launch {
            while (isActive && owner === account && NativeBridge.account() === account) {
                val stop = deadline.stopAt ?: return@launch
                val remaining = java.time.Duration.between(Instant.now(), stop).toMillis()
                if (remaining <= 0) { requestScheduledStop(account); return@launch }
                delay(minOf(remaining, 30_000))
            }
        }
    }
    private fun hasMicrophonePermission() = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun notification(paused: Boolean): Notification {
        val open = packageManager.getLaunchIntentForPackage(packageName)
        val content = open?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
        fun control(action: String, request: Int) = PendingIntent.getService(this, request,
            Intent(this, EchoRecordingService::class.java).setAction(action)
                .setData(android.net.Uri.parse("impo-echo://${owner?.captureSession?.token}/$action"))
                .putExtra(EXTRA_SESSION, owner?.captureSession?.token), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(if (paused) "Echo paused" else "Echo is listening")
            .setContentText(if (paused) "Tap Resume when you're ready." else "Speech is saved on your device, then uploaded securely.")
            .setContentIntent(content).setOngoing(true).setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(0, if (paused) "Resume" else "Pause", control(if (paused) ACTION_RESUME else ACTION_PAUSE, 1))
            .addAction(0, "Stop", control(ACTION_STOP, 2)).build()
    }
    private fun checkAccount() {
        if (owner != null && owner !== NativeBridge.account()) {
            stopCapture(); NativeBridge.mutableRecording.value = EchoRecordingState()
            stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
        }
    }
    override fun onDestroy() {
        if (activeService?.get() === this) activeService = null
        if (owner != null && owner === NativeBridge.account() && NativeBridge.recording.value.isRecording) {
            NativeBridge.mutableRecording.value = NativeBridge.recording.value.copy(status = "paused", level = 0f, speech = false,
                message = "Recording stopped. Tap Resume when you're ready.")
        }
        stopCapture(); scope.cancel(); super.onDestroy()
    }

    companion object {
        const val ACTION_START = "ai.impo.echo.START"
        const val ACTION_PAUSE = "ai.impo.echo.PAUSE"
        const val ACTION_RESUME = "ai.impo.echo.RESUME"
        const val ACTION_STOP = "ai.impo.echo.STOP"
        const val ACTION_ACCOUNT_CHANGED = "ai.impo.echo.ACCOUNT_CHANGED"
        const val EXTRA_SESSION = "recordingSession"
        private const val CHANNEL = "echo_recording"
        private const val NOTIFICATION_ID = 2401
        @Volatile private var activeService: java.lang.ref.WeakReference<EchoRecordingService>? = null
        internal suspend fun finishForDeletion(accountId: String) = withContext(Dispatchers.Main.immediate) {
            val service = activeService?.get() ?: return@withContext
            if (service.owner?.accountId != accountId) return@withContext
            service.transition.withLock {
                val capture = service.capture
                service.stopCapture(); capture?.join()
                service.stopForeground(STOP_FOREGROUND_REMOVE); service.stopSelf()
            }
        }
        internal fun accountChanged() { activeService?.get()?.let { service -> service.scope.launch { service.checkAccount() } } }
        internal fun scheduleChanged(accountId: String, schedule: ai.impo.client.EchoSchedule) {
            val service = activeService?.get() ?: return
            service.scope.launch {
                val owner = service.owner ?: return@launch
                if (owner.accountId != accountId || NativeBridge.account() !== owner) return@launch
                service.deadline.update(schedule)
                service.armStopTimer(owner)
            }
        }
        internal fun control(action: String): Boolean {
            val service = activeService?.get() ?: return false
            val token = NativeBridge.account()?.captureSession?.token
            service.scope.launch { service.onStartCommand(Intent(service, EchoRecordingService::class.java).setAction(action).putExtra(EXTRA_SESSION, token), 0, 0) }
            return true
        }
        internal fun disableLocation() {
            activeService?.get()?.let { service ->
                service.includeLocation = false
                service.activeLocation?.stop(); service.activeLocation = null
            }
        }
    }
}
