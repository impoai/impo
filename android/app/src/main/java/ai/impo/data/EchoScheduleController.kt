package ai.impo.data

import ai.impo.ImpoApplication
import ai.impo.BuildConfig
import ai.impo.client.*
import ai.impo.nativebridge.EchoRecordingService
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

data class EchoScheduleState(val schedule: EchoSchedule = EchoSchedule(), val loaded: Boolean = false,
    val saving: Boolean = false, val error: String? = null)

/** Account-scoped cache allows an already saved stop time to work offline. */
class EchoScheduleController(private val app: ImpoApplication) {
    private val mutable = MutableStateFlow(EchoScheduleState())
    val state = mutable.asStateFlow()
    private var account: Account? = null
    private var client: ImpoClient? = null
    private var generation = 0L
    private var request = 0L
    private var refreshing = false
    private var lastRefresh = 0L
    private var foregroundJob: Job? = null
    fun configure(next: Account?) {
        client?.cancelInFlight(); account = next; generation++; request++; refreshing = false; lastRefresh = 0
        client = next?.let { ImpoClient(it.baseUrl, app.auth.tokenProvider(it), allowInsecureLocalhost = it.development && BuildConfig.DEBUG) }
        mutable.value = EchoScheduleState()
        val captured = generation
        app.scope.launch {
            if (next != null) {
                val cached = app.settings.echoSchedule(next.id)
                if (captured != generation) return@launch
                if (cached != null) { mutable.value = EchoScheduleState(cached); EchoRecordingService.scheduleChanged(next.id, cached) }
                refresh()
            }
        }
    }
    fun foreground(active: Boolean) {
        foregroundJob?.cancel()
        if (active) foregroundJob = app.scope.launch { while (isActive) { refresh(); delay(60_000) } }
    }
    suspend fun refresh(force: Boolean = false) = withContext(Dispatchers.Main.immediate) { refreshOnMain(force) }
    private suspend fun refreshOnMain(force: Boolean) {
        val api = client ?: return
        val owner = account ?: return
        if (refreshing || mutable.value.saving || (!force && System.currentTimeMillis() - lastRefresh < 60_000)) return
        val captured = generation; val operation = ++request
        refreshing = true; lastRefresh = System.currentTimeMillis()
        try {
            val value = api.echoSchedule()
            if (generation != captured || operation != request) return
            app.settings.saveEchoSchedule(owner.id, value)
            if (generation != captured || operation != request) return
            mutable.value = EchoScheduleState(value, loaded = true)
            EchoRecordingService.scheduleChanged(owner.id, value)
        } catch (cancelled: CancellationException) { throw cancelled }
          catch (_: Exception) { if (generation == captured && operation == request) mutable.update { it.copy(error = "Couldn't load your Echo schedule. Your saved stop time still applies.") } }
        finally { if (generation == captured && operation == request) refreshing = false }
    }
    suspend fun save(value: EchoSchedule): Boolean = withContext(Dispatchers.Main.immediate) { saveOnMain(value) }
    private suspend fun saveOnMain(value: EchoSchedule): Boolean {
        val api = client ?: return false
        val owner = account ?: return false
        if (mutable.value.saving || !value.isValid) return false
        val captured = generation; ++request; refreshing = false
        mutable.update { it.copy(saving = true, error = null) }
        return try {
            val saved = api.saveEchoSchedule(value)
            if (generation != captured) return false
            app.settings.saveEchoSchedule(owner.id, saved)
            if (generation != captured) return false
            mutable.value = EchoScheduleState(saved, loaded = true)
            EchoRecordingService.scheduleChanged(owner.id, saved)
            true
        } catch (cancelled: CancellationException) { throw cancelled }
          catch (failure: Exception) {
            if (generation == captured) mutable.update { it.copy(error = if (failure is ApiException && failure.statusCode == 409)
                "Your schedule changed on another device. Reload it before saving." else "Couldn't save your Echo schedule. Please try again.") }
            false
        } finally { if (generation == captured) mutable.update { it.copy(saving = false) } }
    }
}
