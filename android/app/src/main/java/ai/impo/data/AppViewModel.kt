package ai.impo.data

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import ai.impo.ImpoApplication
import ai.impo.client.*
import ai.impo.nativebridge.NativeBridge
import ai.impo.nativebridge.DeviceCoordinator
import ai.impo.nativebridge.DeviceDataAdapter
import ai.impo.nativebridge.RecordedVoiceClip
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

data class AppState(
    val account: Account? = null, val profile: UserSettings = UserSettings(), val profileLoaded: Boolean = false,
    val chat: ConversationSession? = null, val taskSession: ConversationSession? = null,
    val tasks: List<TaskSummary> = emptyList(), val briefs: List<Brief> = emptyList(), val briefCursor: String? = null,
    val briefSettings: BriefSettings? = null, val memories: List<Memory> = emptyList(),
    val memorySummary: MemorySummary = MemorySummary(0, emptyMap()), val memoryCursor: String? = null,
    val memoryCategory: String? = null, val connectors: List<Connector> = emptyList(),
    val timeline: EchoTimeline? = null, val records: Map<String, EchoRecord> = emptyMap(),
    val recordErrors: Set<String> = emptySet(), val selectedRecord: EchoRecord? = null,
    val source: BriefSource? = null, val busy: Set<String> = emptySet(), val errors: Map<String, String> = emptyMap(),
    val pendingTask: String? = null,
)
class AppViewModel(application: Application) : AndroidViewModel(application) {
    val app = application as ImpoApplication
    val auth = app.auth
    private val mutable = MutableStateFlow(AppState())
    val state = mutable.asStateFlow()
    private var api: ImpoClient? = null
    private var accountJob = SupervisorJob()
    private var accountScope = CoroutineScope(viewModelScope.coroutineContext + accountJob)
    private val outbox = FileConversationOutboxStore(File(app.filesDir, "conversation_outbox"))
    private val bodyCache = LinkedHashMap<String, EchoRecord>(180, .75f, true)
    private val hydrating = mutableSetOf<String>()
    private var memoryRequest = 0
    private var accountGeneration = 0
    private var operationSequence = 0L
    private val busyOperations = mutableMapOf<String, MutableSet<Long>>()
    private val latestOperations = mutableMapOf<String, Long>()
    private val refreshJobs = mutableMapOf<String, Job>()
    val devices = DeviceCoordinator(app)
    val deviceAdapter = DeviceDataAdapter(app)
    private var taskCreator: DurableTaskCreator? = null
    private var profileSession: AccountProfileSession? = null
    init {
        viewModelScope.launch {
            auth.state.distinctUntilChangedBy { it.account?.requestScope }.collect { accountState ->
                accountGeneration++
                busyOperations.clear(); latestOperations.clear(); refreshJobs.clear()
                mutable.value.chat?.close(); mutable.value.taskSession?.close(); api?.cancelInFlight()
                accountJob.cancel(); accountJob = SupervisorJob(viewModelScope.coroutineContext[Job])
                accountScope = CoroutineScope(viewModelScope.coroutineContext + accountJob)
                bodyCache.clear(); hydrating.clear(); taskCreator = null; profileSession = null; memoryRequest++
                val account = accountState.account
                api = account?.let { ImpoClient(it.baseUrl, auth.tokenProvider(it), allowInsecureLocalhost = it.development) }
                val chat = account?.let { ConversationSession(api!!, it.id, store = outbox, scope = accountScope, deviceId = { devices.deviceIdFor(it.id) }) }
                mutable.value = AppState(account = account, chat = chat)
                if (account != null) {
                    val generation = accountGeneration
                    val profile = AccountProfileSession(account.id, app.settings, HttpProfileApi(api!!),
                        isCurrent = { generation == accountGeneration && auth.state.value.account?.requestScope == account.requestScope },
                        fallbackName = account.name, development = account.development)
                    profileSession = profile
                    val creator = DurableTaskCreator(api!!, account.id, outbox)
                    taskCreator = creator
                    launch("createTask") {
                        val pending = creator.pendingCommand()?.text
                        ensureCurrentAccount()
                        mutable.update { it.copy(pendingTask = pending) }
                    }
                    accountScope.launch { profile.state.collect { saved ->
                        currentCoroutineContext().ensureActive()
                        if (generation != accountGeneration || auth.state.value.account?.requestScope != account.requestScope) return@collect
                        mutable.update { it.copy(profile = saved.settings, profileLoaded = saved.loaded,
                            busy = if (saved.busy) it.busy + "profile" else it.busy - "profile",
                            errors = if (saved.error == null) it.errors - "profile" else it.errors + ("profile" to saved.error)) }
                    } }
                    accountScope.launch { profile.state.filter { it.localLoaded }.map { it.settings.wifiOnly to it.settings.recordingLocation }.distinctUntilChanged().collect { policy ->
                        if (generation == accountGeneration && auth.state.value.account?.requestScope == account.requestScope && app.nativeAccount?.accountId == account.id) {
                            NativeBridge.setWifiOnly(app, policy.first)
                            NativeBridge.setRecordingLocation(app, policy.second)
                        }
                    } }
                    accountScope.launch { profile.state.filter { it.localLoaded }.map { Triple(it.settings.calendarEnabled, it.settings.healthEnabled, it.settings.contactsEnabled) }.distinctUntilChanged().collectLatest { settings ->
                        if (generation != accountGeneration || auth.state.value.account?.requestScope != account.requestScope) return@collectLatest
                        try { devices.configure(settings.first, settings.second, settings.third) }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { /* Capability registration is retried on resume. */ }
                    } }
                    retryProfile()
                    refreshAll()
                }
            }
        }
    }
    private inner class AccountOperation(private val generation: Int, private val requestScope: String) {
        suspend fun ensureCurrentAccount() {
            currentCoroutineContext().ensureActive()
            if (generation != accountGeneration || auth.state.value.account?.requestScope != requestScope) throw AccountChangedException()
        }
    }
    private fun launch(area: String, replacePrevious: Boolean = false, work: suspend AccountOperation.(ImpoClient) -> Unit): Job? {
        val client = api ?: return null
        val requestScope = state.value.account?.requestScope ?: return null
        val generation = accountGeneration
        val operation = ++operationSequence
        if (replacePrevious) refreshJobs.remove(area)?.cancel()
        val job = accountScope.launch operation@ {
            if (generation != accountGeneration || auth.state.value.account?.requestScope != requestScope) return@operation
            busyOperations.getOrPut(area) { mutableSetOf() }.add(operation)
            latestOperations[area] = operation
            mutable.update { it.copy(busy = it.busy + area, errors = it.errors - area) }
            try { AccountOperation(generation, requestScope).work(client) }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (generation == accountGeneration && auth.state.value.account?.requestScope == requestScope && latestOperations[area] == operation)
                    mutable.update { it.copy(errors = it.errors + (area to (e.message ?: "Couldn't load this. Please try again."))) }
            } finally {
                if (generation == accountGeneration && auth.state.value.account?.requestScope == requestScope) {
                    val remaining = busyOperations[area]
                    remaining?.remove(operation)
                    if (remaining.isNullOrEmpty()) {
                        busyOperations.remove(area)
                        mutable.update { it.copy(busy = it.busy - area) }
                    }
                }
            }
        }
        if (replacePrevious) {
            refreshJobs[area] = job
            job.invokeOnCompletion { if (refreshJobs[area] === job) refreshJobs.remove(area) }
        }
        return job
    }
    fun dismissError(area: String) { mutable.update { it.copy(errors = it.errors - area) } }
    fun refreshAll() {
        launch("chat") { mutable.value.chat?.refresh() }
        refreshTasks(); refreshBriefs(); refreshMemories(); refreshEcho(); refreshConnectors()
        launch("briefSettings") { client -> val settings = client.briefSettings(); ensureCurrentAccount(); mutable.update { it.copy(briefSettings = settings) } }
    }
    fun resumed() { devices.start(); launch("chat") { mutable.value.chat?.refresh() }; retryProfile(); refreshTasks(); refreshConnectors() }
    fun paused() { devices.stop() }
    fun send(text: String, task: Boolean = false) {
        val session = (if (task) mutable.value.taskSession else mutable.value.chat) ?: return
        launch(if (task) "task" else "chat") { session.send(text) }
    }
    /** Once released into Chat, acceptance belongs to the account, not the visible screen. */
    suspend fun sendVoice(clip: RecordedVoiceClip, owner: String): Boolean {
        requireVoiceOwner(owner)
        val session = mutable.value.chat ?: throw AccountChangedException()
        val value = VoiceClip.fromBytes(clip.bytes(), clip.mimeType)
        return accountScope.async {
            requireVoiceOwner(owner)
            if (mutable.value.chat !== session) throw AccountChangedException()
            session.sendVoice(value)
        }.await()
    }
    /** Draft/task transcription does not accept a Chat message and follows the caller's lifecycle. */
    suspend fun transcribeVoice(clip: RecordedVoiceClip, owner: String): String {
        requireVoiceOwner(owner)
        val client = api ?: throw AccountChangedException()
        val text = client.transcribeVoice(VoiceClip.fromBytes(clip.bytes(), clip.mimeType))
        currentCoroutineContext().ensureActive()
        requireVoiceOwner(owner)
        if (client !== api) throw AccountChangedException()
        return text
    }
    private fun requireVoiceOwner(owner: String) {
        if (state.value.account?.requestScope != owner || auth.state.value.account?.requestScope != owner)
            throw AccountChangedException()
    }
    fun retryChat(task: Boolean = false) {
        val session = (if (task) mutable.value.taskSession else mutable.value.chat) ?: return
        launch(if (task) "task" else "chat") { session.retryPending() }
    }
    fun cancelChat(task: Boolean = false) {
        val session = (if (task) mutable.value.taskSession else mutable.value.chat) ?: return
        launch(if (task) "task" else "chat") { session.cancel() }
    }
    fun refreshTasks() { launch("tasks", replacePrevious = true) { client -> val rows = client.tasks(); ensureCurrentAccount(); mutable.update { it.copy(tasks = rows) } } }
    fun createTask(text: String, opened: (String) -> Unit) {
        val creator = taskCreator ?: return
        launch("createTask") {
            try {
                val receipt = creator.create(text)
                ensureCurrentAccount()
                refreshTasks(); opened(receipt.taskId); creator.acknowledge(receipt.taskId)
            } finally { updatePendingTaskIfCurrent(creator) }
        }
    }
    fun recoverTask(opened: (String) -> Unit) {
        val creator = taskCreator ?: return
        launch("createTask") {
            try { creator.retry()?.let { receipt -> ensureCurrentAccount(); refreshTasks(); opened(receipt.taskId); creator.acknowledge(receipt.taskId) } }
            finally { updatePendingTaskIfCurrent(creator) }
        }
    }
    private suspend fun updatePendingTaskIfCurrent(creator: DurableTaskCreator) {
        if (currentCoroutineContext().isActive && creator === taskCreator) {
            try {
                val pending = creator.pendingCommand()?.text
                if (creator === taskCreator) mutable.update { it.copy(pendingTask = pending) }
            } catch (cancelled: CancellationException) { throw cancelled }
              catch (_: Exception) { /* Keep the prior pending indicator if its private file cannot be read. */ }
        }
    }
    fun openTask(id: String) {
        mutable.value.taskSession?.close()
        val account = mutable.value.account ?: return
        val client = api ?: return
        val session = ConversationSession(client, account.id, id, outbox, accountScope)
        mutable.update { it.copy(taskSession = session) }
        launch("task") { session.refresh() }
    }
    fun refreshBriefs(more: Boolean = false, date: String? = null) {
        val cursor = if (more) mutable.value.briefCursor else null
        launch("briefs", replacePrevious = true) { client ->
            val page = client.briefs(cursor = cursor, date = date)
            ensureCurrentAccount()
            mutable.update { it.copy(briefs = (if (more) it.briefs + page.briefs else page.briefs).distinctBy(Brief::id), briefCursor = page.nextCursor) }
        }
    }
    fun deleteBrief(id: String) { launch("briefs") { it.deleteBrief(id); ensureCurrentAccount(); refreshBriefs() } }
    fun loadSource(briefId: String, recordId: String) {
        mutable.update { it.copy(source = null) }
        launch("source", replacePrevious = true) { client -> val source = client.briefSource(briefId, recordId); ensureCurrentAccount(); mutable.update { it.copy(source = source) } }
    }
    fun saveBriefSettings(value: BriefSettings, done: () -> Unit) { launch("briefSettings") { client -> val saved = client.updateBriefSettings(value); ensureCurrentAccount(); mutable.update { it.copy(briefSettings = saved) }; done() } }
    fun defaultBriefSettings() = BriefSettings(ZoneId.systemDefault().id, Locale.getDefault().toLanguageTag(), mutable.value.profile.displayName,
        slots = listOf(BriefSlot("morning", "Morning Brief", 8, true), BriefSlot("midday", "Midday Brief", 13, true), BriefSlot("evening", "Evening Brief", 20, true)))
    fun refreshMemories(category: String? = mutable.value.memoryCategory, more: Boolean = false) {
        val request = ++memoryRequest
        val cursor = if (more) mutable.value.memoryCursor else null
        mutable.update { it.copy(memoryCategory = category) }
        launch("memories", replacePrevious = true) { client ->
            val page = client.memories(category, cursor)
            val summary = client.memorySummary()
            ensureCurrentAccount()
            if (request == memoryRequest) mutable.update { it.copy(memories = (if (more) it.memories + page.memories else page.memories).distinctBy(Memory::id), memoryCursor = page.nextCursor, memorySummary = summary) }
        }
    }
    fun forgetMemory(id: String) { launch("memories") { it.deleteMemory(id); ensureCurrentAccount(); refreshMemories() } }
    fun refreshEcho() {
        launch("echo", replacePrevious = true) { client ->
            val timeline = client.echoTimeline(ZoneId.systemDefault().id)
            ensureCurrentAccount()
            val ids = timeline.days.flatMap { it.ids }.toSet()
            bodyCache.keys.retainAll(ids)
            mutable.update { it.copy(timeline = timeline, records = bodyCache.toMap(), recordErrors = emptySet()) }
            hydrate(timeline.days.flatMap { it.ids }.take(30))
        }
    }
    fun hydrate(ids: List<String>, retry: Boolean = false) {
        val client = api ?: return
        val generation = accountGeneration
        ids.forEach { bodyCache[it] } // Visible rows renew their place in the bounded LRU cache.
        val needed = ids.distinct().filter { it !in bodyCache && it !in hydrating && (retry || it !in mutable.value.recordErrors) }.take(30)
        if (needed.isEmpty()) return
        hydrating.addAll(needed)
        accountScope.launch {
            try {
                val rows = client.echoRecords(needed)
                if (generation != accountGeneration) return@launch
                rows.forEach { bodyCache[it.id] = it }
                while (bodyCache.size > 180) bodyCache.remove(bodyCache.keys.first())
                val missing = needed.toSet() - rows.map { it.id }.toSet()
                mutable.update { state -> state.copy(records = bodyCache.toMap(), recordErrors = state.recordErrors - needed.toSet(),
                    timeline = if (missing.isEmpty()) state.timeline else state.timeline?.copy(days = state.timeline.days.map { it.copy(ids = it.ids - missing) }.filter { it.ids.isNotEmpty() })) }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { if (generation == accountGeneration) mutable.update { it.copy(recordErrors = it.recordErrors + needed) } }
            finally { if (generation == accountGeneration) hydrating.removeAll(needed.toSet()) }
        }
    }
    fun openRecord(id: String) {
        mutable.update { it.copy(selectedRecord = bodyCache[id]) }
        launch("record", replacePrevious = true) { client ->
            val row = client.echoRecords(listOf(id)).firstOrNull() ?: throw IllegalStateException("This recording is no longer available.")
            ensureCurrentAccount()
            mutable.update { it.copy(selectedRecord = row) }
        }
    }
    fun labelRecord(id: String, label: String?) { launch("record") { client -> val row = client.updateEchoLabel(id, label); ensureCurrentAccount(); bodyCache[id] = row; mutable.update { it.copy(selectedRecord = if (it.selectedRecord?.id == id) row else it.selectedRecord, records = bodyCache.toMap()) } } }
    fun deleteRecord(id: String, done: () -> Unit) { launch("record") { it.deleteEchoRecord(id); ensureCurrentAccount(); bodyCache.remove(id); mutable.update { it.copy(selectedRecord = it.selectedRecord?.takeUnless { record -> record.id == id }) }; refreshEcho(); refreshBriefs(); done() } }
    fun retryTranscription(id: String) { launch("record") { it.retryBatch(id); ensureCurrentAccount(); mutable.value.selectedRecord?.let { openRecord(it.id) } } }
    fun refreshConnectors() { launch("connectors", replacePrevious = true) { client ->
        val rows = client.connectors()
        rows.filter { it.status == "pending" }.forEach {
            try { client.refreshConnector(it.toolkit) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { /* Preserve the explicit pending state and retry on resume. */ }
        }
        val current = if (rows.any { it.status == "pending" }) client.connectors() else rows
        ensureCurrentAccount()
        mutable.update { it.copy(connectors = current) }
    } }
    fun connect(toolkit: String, browse: (String) -> Unit) { launch("connectors") { client -> val result = client.connectConnector(toolkit); ensureCurrentAccount(); browse(result.redirectURL); refreshConnectors() } }
    fun disconnect(toolkit: String) { launch("connectors") { it.disconnectConnector(toolkit); ensureCurrentAccount(); refreshConnectors() } }
    fun saveProfile(value: UserSettings) {
        saveProfile(value) {}
    }
    fun saveProfile(value: UserSettings, onSaved: () -> Unit) {
        val profile = profileSession ?: return
        val requestScope = state.value.account?.requestScope ?: return
        val baseline = state.value.profile
        accountScope.launch {
            val saved = profile.save(value, baseline)
            currentCoroutineContext().ensureActive()
            if (profile !== profileSession || auth.state.value.account?.requestScope != requestScope) return@launch
            if (saved) onSaved()
        }
    }
    fun retryProfile() {
        val profile = profileSession ?: return
        refreshJobs.remove("profile")?.cancel()
        val job = accountScope.launch { profile.restore() }
        refreshJobs["profile"] = job
        job.invokeOnCompletion { if (refreshJobs["profile"] === job) refreshJobs.remove("profile") }
    }
    fun signOut() { launch("account") {
        NativeBridge.stopEcho(app)
        try { app.push.revokeBeforeSignOut(); auth.signOut() }
        catch (error: Exception) { app.push.configure(auth.state.value.account); throw error }
    } }
    fun openNotificationBrief(id: String) {
        launch("briefs") { client ->
            val brief = client.brief(id); ensureCurrentAccount()
            mutable.update { it.copy(briefs = listOf(brief) + it.briefs.filter { old -> old.id != id }) }
        }
    }
    override fun onCleared() { devices.stop(); mutable.value.chat?.close(); mutable.value.taskSession?.close(); accountJob.cancel(); api?.cancelInFlight(); super.onCleared() }
}
