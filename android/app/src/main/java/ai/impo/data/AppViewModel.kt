package ai.impo.data

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import ai.impo.ImpoApplication
import ai.impo.client.*
import ai.impo.nativebridge.NativeBridge
import ai.impo.nativebridge.DeviceCoordinator
import ai.impo.nativebridge.DeviceDataAdapter
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
    init {
        viewModelScope.launch {
            auth.state.distinctUntilChangedBy { it.account?.id }.collect { accountState ->
                accountGeneration++
                busyOperations.clear(); latestOperations.clear(); refreshJobs.clear()
                mutable.value.chat?.close(); mutable.value.taskSession?.close(); api?.cancelInFlight()
                accountJob.cancel(); accountJob = SupervisorJob(viewModelScope.coroutineContext[Job])
                accountScope = CoroutineScope(viewModelScope.coroutineContext + accountJob)
                bodyCache.clear(); hydrating.clear(); taskCreator = null; memoryRequest++
                val account = accountState.account
                api = account?.let { ImpoClient(it.baseUrl, auth.tokenProvider(it), allowInsecureLocalhost = it.development) }
                val chat = account?.let { ConversationSession(api!!, it.id, store = outbox, scope = accountScope, deviceId = { devices.deviceIdFor(it.id) }) }
                mutable.value = AppState(account = account, chat = chat)
                if (account != null) {
                    val creator = DurableTaskCreator(api!!, account.id, outbox)
                    taskCreator = creator
                    launch("createTask") {
                        val pending = creator.pendingCommand()?.text
                        mutable.update { it.copy(pendingTask = pending) }
                    }
                    accountScope.launch { app.settings.observe(account.id).collect { settings ->
                        mutable.update { it.copy(profile = settings, profileLoaded = true) }
                        try { devices.configure(settings.calendarEnabled, settings.healthEnabled) }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { /* Capability registration is retried on resume. */ }
                    } }
                    refreshAll()
                }
            }
        }
    }
    private fun launch(area: String, replacePrevious: Boolean = false, work: suspend (ImpoClient) -> Unit): Job? {
        val client = api ?: return null
        val generation = accountGeneration
        val operation = ++operationSequence
        if (replacePrevious) refreshJobs.remove(area)?.cancel()
        val job = accountScope.launch operation@ {
            if (generation != accountGeneration) return@operation
            busyOperations.getOrPut(area) { mutableSetOf() }.add(operation)
            latestOperations[area] = operation
            mutable.update { it.copy(busy = it.busy + area, errors = it.errors - area) }
            try { work(client) }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (generation == accountGeneration && latestOperations[area] == operation)
                    mutable.update { it.copy(errors = it.errors + (area to (e.message ?: "Couldn't load this. Please try again."))) }
            } finally {
                if (generation == accountGeneration) {
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
        launch("briefSettings") { client -> val settings = client.briefSettings(); mutable.update { it.copy(briefSettings = settings) } }
    }
    fun resumed() { devices.start(); launch("chat") { mutable.value.chat?.refresh() }; refreshTasks(); refreshConnectors() }
    fun paused() { devices.stop() }
    fun send(text: String, task: Boolean = false) {
        val session = (if (task) mutable.value.taskSession else mutable.value.chat) ?: return
        launch(if (task) "task" else "chat") { session.send(text) }
    }
    fun retryChat(task: Boolean = false) {
        val session = (if (task) mutable.value.taskSession else mutable.value.chat) ?: return
        launch(if (task) "task" else "chat") { session.retryPending() }
    }
    fun cancelChat(task: Boolean = false) {
        val session = (if (task) mutable.value.taskSession else mutable.value.chat) ?: return
        launch(if (task) "task" else "chat") { session.cancel() }
    }
    fun refreshTasks() { launch("tasks", replacePrevious = true) { client -> val rows = client.tasks(); mutable.update { it.copy(tasks = rows) } } }
    fun createTask(text: String, opened: (String) -> Unit) {
        val creator = taskCreator ?: return
        launch("createTask") {
            try {
                val receipt = creator.create(text)
                refreshTasks(); opened(receipt.taskId); creator.acknowledge(receipt.taskId)
            } finally { updatePendingTaskIfCurrent(creator) }
        }
    }
    fun recoverTask(opened: (String) -> Unit) {
        val creator = taskCreator ?: return
        launch("createTask") {
            try { creator.retry()?.let { receipt -> refreshTasks(); opened(receipt.taskId); creator.acknowledge(receipt.taskId) } }
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
            mutable.update { it.copy(briefs = (if (more) it.briefs + page.briefs else page.briefs).distinctBy(Brief::id), briefCursor = page.nextCursor) }
        }
    }
    fun deleteBrief(id: String) { launch("briefs") { it.deleteBrief(id); refreshBriefs() } }
    fun loadSource(briefId: String, recordId: String) {
        mutable.update { it.copy(source = null) }
        launch("source", replacePrevious = true) { client -> val source = client.briefSource(briefId, recordId); mutable.update { it.copy(source = source) } }
    }
    fun saveBriefSettings(value: BriefSettings, done: () -> Unit) { launch("briefSettings") { client -> val saved = client.updateBriefSettings(value); mutable.update { it.copy(briefSettings = saved) }; done() } }
    fun defaultBriefSettings() = BriefSettings(ZoneId.systemDefault().id, Locale.getDefault().toLanguageTag(), mutable.value.profile.displayName,
        slots = listOf(BriefSlot("morning", "Morning Brief", 8, true), BriefSlot("midday", "Midday Brief", 13, true), BriefSlot("evening", "Evening Brief", 20, true)))
    fun refreshMemories(category: String? = mutable.value.memoryCategory, more: Boolean = false) {
        val request = ++memoryRequest
        val cursor = if (more) mutable.value.memoryCursor else null
        mutable.update { it.copy(memoryCategory = category) }
        launch("memories", replacePrevious = true) { client ->
            val page = client.memories(category, cursor)
            val summary = client.memorySummary()
            if (request == memoryRequest) mutable.update { it.copy(memories = (if (more) it.memories + page.memories else page.memories).distinctBy(Memory::id), memoryCursor = page.nextCursor, memorySummary = summary) }
        }
    }
    fun forgetMemory(id: String) { launch("memories") { it.deleteMemory(id); refreshMemories() } }
    fun refreshEcho() {
        launch("echo", replacePrevious = true) { client ->
            val timeline = client.echoTimeline(ZoneId.systemDefault().id)
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
            mutable.update { it.copy(selectedRecord = row) }
        }
    }
    fun labelRecord(id: String, label: String?) { launch("record") { client -> val row = client.updateEchoLabel(id, label); bodyCache[id] = row; mutable.update { it.copy(selectedRecord = if (it.selectedRecord?.id == id) row else it.selectedRecord, records = bodyCache.toMap()) } } }
    fun deleteRecord(id: String, done: () -> Unit) { launch("record") { it.deleteEchoRecord(id); bodyCache.remove(id); mutable.update { it.copy(selectedRecord = it.selectedRecord?.takeUnless { record -> record.id == id }) }; refreshEcho(); refreshBriefs(); done() } }
    fun retryTranscription(id: String) { launch("record") { it.retryBatch(id); mutable.value.selectedRecord?.let { openRecord(it.id) } } }
    fun refreshConnectors() { launch("connectors", replacePrevious = true) { client ->
        val rows = client.connectors()
        rows.filter { it.status == "pending" }.forEach {
            try { client.refreshConnector(it.toolkit) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { /* Preserve the explicit pending state and retry on resume. */ }
        }
        val current = if (rows.any { it.status == "pending" }) client.connectors() else rows
        mutable.update { it.copy(connectors = current) }
    } }
    fun connect(toolkit: String, browse: (String) -> Unit) { launch("connectors") { client -> val result = client.connectConnector(toolkit); browse(result.redirectURL); refreshConnectors() } }
    fun disconnect(toolkit: String) { launch("connectors") { it.disconnectConnector(toolkit); refreshConnectors() } }
    fun saveProfile(value: UserSettings) {
        val id = state.value.account?.id ?: return
        launch("profile") {
            app.settings.save(id, value)
            if (state.value.account?.id == id) NativeBridge.setWifiOnly(app, value.wifiOnly)
        }
    }
    fun signOut() { launch("account") { NativeBridge.stopEcho(app); auth.signOut() } }
    override fun onCleared() { devices.stop(); mutable.value.chat?.close(); mutable.value.taskSession?.close(); accountJob.cancel(); api?.cancelInFlight(); super.onCleared() }
}
