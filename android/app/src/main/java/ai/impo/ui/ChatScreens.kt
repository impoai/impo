package ai.impo.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import ai.impo.client.ApiException
import ai.impo.nativebridge.RecordedVoiceClip
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import ai.impo.client.ConversationState
import ai.impo.data.AppState
import ai.impo.data.AppViewModel

@Composable fun ChatScreen(vm: AppViewModel, state: AppState, go: (String) -> Unit) {
    val conversation = state.chat?.state?.collectAsStateWithLifecycle()?.value ?: ConversationState()
    val owner = state.account?.requestScope
    val session = state.chat
    var searchOpen by rememberSaveable { mutableStateOf(false) }
    var search by rememberSaveable { mutableStateOf("") }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).clickable { go("assistant") }, verticalAlignment = Alignment.CenterVertically) {
                AssistantAvatar(state.profile.avatar)
                Text(state.profile.assistantName, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 10.dp))
            }
            IconButton(onClick = { searchOpen = !searchOpen; if (!searchOpen) search = "" }) { Icon(Icons.Outlined.Search, "Search conversation") }
            IconButton(onClick = { go("settings") }, modifier = Modifier.testTag("settings.open")) { Icon(Icons.Outlined.Settings, "Settings") }
        }
        if (searchOpen) OutlinedTextField(search, { search = it }, label = { Text("Search this conversation") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp))
        ConversationBody(conversation, search, Modifier.weight(1f), state.profile.assistantName, { vm.retryChat() })
        ErrorNotice(state.errors["chat"], { vm.retryChat() })
        MessageComposer(vm, conversation, { vm.send(it) }, { vm.cancelChat() }, "chat", session != null,
            owner to session, { vm.state.value.account?.requestScope == owner && vm.state.value.chat === session })
    }
}
@Composable fun TaskConversationScreen(vm: AppViewModel, state: AppState, back: () -> Unit) {
    val conversation = state.taskSession?.state?.collectAsStateWithLifecycle()?.value ?: ConversationState(loading = true)
    val owner = state.account?.requestScope
    val session = state.taskSession
    Column(Modifier.fillMaxSize()) {
        PageHeader("Task", conversation.title, back)
        ConversationBody(conversation, "", Modifier.weight(1f), state.profile.assistantName, { vm.retryChat(true) })
        ErrorNotice(state.errors["task"], { vm.retryChat(true) })
        MessageComposer(vm, conversation, { vm.send(it, true) }, { vm.cancelChat(true) }, "task", session != null,
            owner to session, { vm.state.value.account?.requestScope == owner && vm.state.value.taskSession === session })
    }
}
@Composable private fun ConversationBody(conversation: ConversationState, search: String, modifier: Modifier, assistant: String, retry: () -> Unit) {
    val list = rememberLazyListState()
    var follow by remember { mutableStateOf(true) }
    var selecting by remember { mutableStateOf(emptySet<String>()) }
    val dragging by list.interactionSource.collectIsDraggedAsState()
    val messages = remember(conversation.messages, search) { conversation.messages.filter { search.isBlank() || it.text.contains(search, true) } }
    val visiblePendingVoice = conversation.pendingVoice?.takeIf { search.isBlank() }
    LaunchedEffect(dragging) { if (dragging) follow = false }
    LaunchedEffect(list) { snapshotFlow { list.isScrollInProgress || list.canScrollForward }.collect { if (!it) follow = true } }
    LaunchedEffect(messages.lastOrNull()?.text, messages.size, visiblePendingVoice, follow, selecting) {
        if (follow && selecting.isEmpty() && (messages.isNotEmpty() || visiblePendingVoice != null)) {
            // Scaffold can compose this effect during measurement. Scroll after that pass.
            withFrameNanos { }
            if (list.layoutInfo.totalItemsCount == 0) return@LaunchedEffect
            list.scrollToItem(list.layoutInfo.totalItemsCount - 1)
            list.layoutInfo.visibleItemsInfo.lastOrNull()?.let { last ->
                list.scrollBy((last.offset + last.size - list.layoutInfo.viewportEndOffset).coerceAtLeast(0).toFloat())
            }
        }
    }
    Column(modifier) {
        BusyLine(conversation.loading)
        ErrorNotice(conversation.error, retry)
        LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("conversation.messages"), state = list,
            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            if (messages.isEmpty() && !conversation.loading && visiblePendingVoice == null) item {
                EmptyState(if (search.isBlank()) "What's on your mind?" else "No matching messages",
                    if (search.isBlank()) "Ask $assistant to think with you, plan your day, or take something off your plate." else "Try another word or phrase.")
            }
            items(messages, key = { it.id }) { message ->
                Column(Modifier.fillMaxWidth()) {
                    if (message.role == "user") Surface(Modifier.align(Alignment.End).widthIn(max = 340.dp), shape = RoundedCornerShape(24.dp, 24.dp, 6.dp, 24.dp), color = Sage.copy(alpha = .65f)) {
                        SelectionContainer { Text(message.text, Modifier.padding(16.dp), style = MaterialTheme.typography.bodyLarge) }
                    } else {
                        if (message.text.isNotBlank()) RichResponse(message.text, Modifier.fillMaxWidth(), message.status in setOf("queued", "running", "waiting_device"), onSelectionChanged = { active -> selecting = if (active) selecting + message.id else selecting - message.id })
                        else if (conversation.busy && conversation.pendingVoice == null) Text("Thinking…", color = Muted)
                        if (message.status in setOf("failed", "cancelled")) Text(humanStatus(message.status), style = MaterialTheme.typography.labelSmall, color = Muted)
                    }
                }
            }
            visiblePendingVoice?.let { voice -> item(key = "voice:${voice.clientMessageId}") {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    Surface(shape = RoundedCornerShape(24.dp, 24.dp, 6.dp, 24.dp), color = Sage.copy(alpha = .65f),
                        modifier = Modifier.testTag("chat.voice.pending")) {
                        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            if (voice.transcribing) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                            Text(if (voice.transcribing) "Transcribing…" else "Voice message saved · Retry to send", style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                }
            } }
            if (conversation.busy && conversation.steps.isNotEmpty()) item {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { conversation.steps.takeLast(4).forEach { step ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(if (step.status == "completed") Icons.Outlined.Check else Icons.Outlined.MoreHoriz, null, Modifier.size(16.dp), tint = Muted)
                        Text(step.title, style = MaterialTheme.typography.bodySmall, color = Muted, modifier = Modifier.padding(start = 6.dp))
                    }
                } }
            }
        }
        if (!follow && messages.isNotEmpty()) TextButton(onClick = { follow = true }, modifier = Modifier.align(Alignment.CenterHorizontally)) { Icon(Icons.Outlined.ArrowDownward, null); Text("Latest reply") }
        if (conversation.hasPendingMessage && !conversation.busy) TextButton(onClick = retry, modifier = Modifier.align(Alignment.CenterHorizontally).testTag("chat.retry")) { Text("Retry saved message") }
    }
}
@Composable private fun MessageComposer(vm: AppViewModel, conversation: ConversationState, send: (String) -> Unit, cancel: () -> Unit,
    prefix: String, available: Boolean, sessionKey: Any?, isCurrent: () -> Boolean) {
    var text by rememberSaveable(sessionKey) { mutableStateOf("") }
    ServerVoiceComposer(vm, text, { text = it }, conversation.activeSubmissionIds.isNotEmpty() || (conversation.busy && conversation.pendingVoice == null),
        !conversation.hasPendingMessage && available && !conversation.loading, send, cancel, prefix, sessionKey, isCurrent,
        sendVoiceToChat = prefix == "chat", allowVoice = available, admissionPending = conversation.pendingVoice?.transcribing == true)
}

/** Only draft transcription follows the view lifecycle. A released Chat command is durable. */
@Composable private fun ServerVoiceComposer(vm: AppViewModel, value: String, onValueChange: (String) -> Unit, busy: Boolean, allowSend: Boolean,
    send: (String) -> Unit, cancel: () -> Unit, prefix: String, sessionKey: Any?, isCurrent: () -> Boolean,
    sendVoiceToChat: Boolean, allowVoice: Boolean = true, admissionPending: Boolean = false,
    inputTag: String = "$prefix.input", placeholder: String = "Tap to type · Hold to talk", maxLength: Int = 32768, showSendControl: Boolean = true) {
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val appState by vm.state.collectAsStateWithLifecycle()
    val owner = appState.account?.requestScope
    var job by remember(sessionKey) { mutableStateOf<Job?>(null) }
    var pending by remember(sessionKey) { mutableStateOf(false) }
    var notice by remember(sessionKey) { mutableStateOf<String?>(null) }
    val latestValue by rememberUpdatedState(value)
    val latestCurrent by rememberUpdatedState(isCurrent)
    val latestBusy by rememberUpdatedState(busy)
    val latestAllowSend by rememberUpdatedState(allowSend)
    val latestChanged by rememberUpdatedState(onValueChange)
    val latestSend by rememberUpdatedState(send)
    DisposableEffect(lifecycle, sessionKey) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) { job?.cancel(); pending = false } }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); job?.cancel() }
    }
    fun receive(clip: RecordedVoiceClip) {
        if (!latestCurrent() || owner == null || pending || admissionPending) return
        val sendToChat = sendVoiceToChat && !latestBusy && latestAllowSend
        pending = true; notice = null
        job = scope.launch {
            try {
                if (sendToChat && vm.sendVoice(clip, owner)) return@launch
                val transcript = vm.transcribeVoice(clip, owner)
                if (!latestCurrent()) return@launch
                if (!sendVoiceToChat && latestValue.isBlank() && !latestBusy && latestAllowSend && transcript.length <= maxLength) latestSend(transcript)
                else {
                    val draft = listOf(latestValue.trimEnd(), transcript).filter { it.isNotEmpty() }.joinToString(" ")
                    latestChanged(draft)
                    if (draft.length > maxLength) notice = "Shorten this draft to $maxLength characters before sending."
                }
            } catch (cancelled: CancellationException) { throw cancelled }
              catch (failure: Exception) {
                if (latestCurrent()) notice = if (failure is ApiException && failure.code == "empty_transcript")
                    "No speech was recognized. Hold the input while you speak, then release."
                    else "Couldn't transcribe that. Check your connection and try again."
            } finally { pending = false }
        }
    }
    VoiceComposer(value, onValueChange, busy, allowSend && value.length <= maxLength, send, cancel, prefix, sessionKey,
        onVoiceClip = ::receive, isCurrent = isCurrent, voicePending = pending || admissionPending, voiceNotice = notice, allowVoice = allowVoice,
        inputTag = inputTag, placeholder = placeholder, maxLength = maxLength, showSendControl = showSendControl)
}
@Composable fun TasksScreen(vm: AppViewModel, state: AppState, go: (String) -> Unit) {
    var create by remember { mutableStateOf(false) }
    var prompt by rememberSaveable { mutableStateOf("") }
    val owner = state.account?.requestScope
    fun createTask(text: String) {
        if (text.isBlank() || text.length > 4000 || "createTask" in state.busy || state.pendingTask != null) return
        vm.createTask(text.trim()) { id -> create = false; prompt = ""; go("task/$id") }
    }
    Column(Modifier.fillMaxSize()) {
        PageHeader("Tasks", "A little help moving things forward.", actions = {
            IconButton(onClick = { vm.refreshTasks() }) { Icon(Icons.Outlined.Refresh, "Refresh tasks") }
            IconButton(onClick = { create = true }, modifier = Modifier.testTag("tasks.new")) { Icon(Icons.Outlined.Add, "New task") }
        })
        BusyLine("tasks" in state.busy)
        ErrorNotice(state.errors["tasks"], { vm.refreshTasks() })
        ErrorNotice(state.errors["createTask"])
        if (state.pendingTask != null) PaperCard(Modifier.padding(horizontal = 16.dp).fillMaxWidth()) {
            Text("A task is waiting to be recovered", style = MaterialTheme.typography.titleLarge)
            Text(state.pendingTask, maxLines = 3)
            TextButton(onClick = { vm.recoverTask { go("task/$it") } }, enabled = "createTask" !in state.busy) { Text("Recover task") }
        }
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxSize().testTag("tasks.list")) {
            if (state.tasks.isEmpty() && "tasks" !in state.busy) item { EmptyState("Make room for your day", "Delegate research, a plan, or a piece of writing. Each task has its own conversation.", "Create a task", { create = true }) }
            items(state.tasks, key = { it.taskId }) { task -> PaperCard(Modifier.fillMaxWidth().clickable { go("task/${task.taskId}") }.testTag("task.${task.taskId}")) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(humanStatus(task.status), style = MaterialTheme.typography.labelMedium, color = Forest)
                    Text(shortDate(task.updatedAt ?: task.createdAt), style = MaterialTheme.typography.labelSmall, color = Muted)
                }
                Text(task.title, style = MaterialTheme.typography.titleLarge, maxLines = 3)
                Text("Open conversation →", color = Muted, style = MaterialTheme.typography.bodySmall)
            } }
        }
    }
    if (create) AlertDialog(onDismissRequest = { create = false }, title = { Text("What can I take care of?") }, text = {
        Column {
            ServerVoiceComposer(vm, prompt, { prompt = it }, "createTask" in state.busy, state.pendingTask == null,
                ::createTask, {}, "newTask", owner to "newTask", { create && vm.state.value.account?.requestScope == owner },
                sendVoiceToChat = false, allowVoice = "createTask" !in state.busy && state.pendingTask == null,
                inputTag = "tasks.prompt", placeholder = "Describe your task · Hold to talk", maxLength = 4000, showSendControl = false)
            ErrorNotice(state.errors["createTask"])
        }
    }, confirmButton = { TextButton(onClick = { createTask(prompt) }, enabled = prompt.isNotBlank() && prompt.length <= 4000 && "createTask" !in state.busy && state.pendingTask == null,
        modifier = Modifier.testTag("tasks.create")) { Text("Create task") } }, dismissButton = { TextButton(onClick = { create = false }) { Text("Cancel") } })
}
