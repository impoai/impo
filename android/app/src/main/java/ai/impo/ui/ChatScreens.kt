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
import ai.impo.client.ConversationState
import ai.impo.data.AppState
import ai.impo.data.AppViewModel

@Composable fun ChatScreen(vm: AppViewModel, state: AppState, go: (String) -> Unit) {
    val conversation = state.chat?.state?.collectAsStateWithLifecycle()?.value ?: ConversationState()
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
        MessageComposer(conversation.busy || conversation.activeSubmissionIds.isNotEmpty(), { vm.send(it) }, { vm.cancelChat() }, "chat", !conversation.hasPendingMessage)
    }
}
@Composable fun TaskConversationScreen(vm: AppViewModel, state: AppState, back: () -> Unit) {
    val conversation = state.taskSession?.state?.collectAsStateWithLifecycle()?.value ?: ConversationState(loading = true)
    Column(Modifier.fillMaxSize()) {
        PageHeader("Task", conversation.title, back)
        ConversationBody(conversation, "", Modifier.weight(1f), state.profile.assistantName, { vm.retryChat(true) })
        ErrorNotice(state.errors["task"], { vm.retryChat(true) })
        MessageComposer(conversation.busy || conversation.activeSubmissionIds.isNotEmpty(), { vm.send(it, true) }, { vm.cancelChat(true) }, "task", !conversation.hasPendingMessage)
    }
}
@Composable private fun ConversationBody(conversation: ConversationState, search: String, modifier: Modifier, assistant: String, retry: () -> Unit) {
    val list = rememberLazyListState()
    var follow by remember { mutableStateOf(true) }
    var selecting by remember { mutableStateOf(emptySet<String>()) }
    val dragging by list.interactionSource.collectIsDraggedAsState()
    val messages = remember(conversation.messages, search) { conversation.messages.filter { search.isBlank() || it.text.contains(search, true) } }
    LaunchedEffect(dragging) { if (dragging) follow = false }
    LaunchedEffect(list) { snapshotFlow { list.isScrollInProgress || list.canScrollForward }.collect { if (!it) follow = true } }
    LaunchedEffect(messages.lastOrNull()?.text, messages.size, follow, selecting) {
        if (follow && selecting.isEmpty() && messages.isNotEmpty()) {
            // Scaffold can compose this effect during measurement. Scroll after that pass.
            withFrameNanos { }
            list.scrollToItem(maxOf(messages.lastIndex, list.layoutInfo.totalItemsCount - 1))
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
            if (messages.isEmpty() && !conversation.loading) item {
                EmptyState(if (search.isBlank()) "What's on your mind?" else "No matching messages",
                    if (search.isBlank()) "Ask $assistant to think with you, plan your day, or take something off your plate." else "Try another word or phrase.")
            }
            items(messages, key = { it.id }) { message ->
                Column(Modifier.fillMaxWidth()) {
                    if (message.role == "user") Surface(Modifier.align(Alignment.End).widthIn(max = 340.dp), shape = RoundedCornerShape(24.dp, 24.dp, 6.dp, 24.dp), color = Sage.copy(alpha = .65f)) {
                        SelectionContainer { Text(message.text, Modifier.padding(16.dp), style = MaterialTheme.typography.bodyLarge) }
                    } else {
                        if (message.text.isNotBlank()) RichResponse(message.text, Modifier.fillMaxWidth(), message.status in setOf("queued", "running", "waiting_device"), onSelectionChanged = { active -> selecting = if (active) selecting + message.id else selecting - message.id })
                        else if (conversation.busy) Text("Thinking…", color = Muted)
                        if (message.status in setOf("failed", "cancelled")) Text(humanStatus(message.status), style = MaterialTheme.typography.labelSmall, color = Muted)
                    }
                }
            }
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
@Composable private fun MessageComposer(busy: Boolean, send: (String) -> Unit, cancel: () -> Unit, prefix: String, allowSend: Boolean) {
    var text by rememberSaveable { mutableStateOf("") }
    fun submit() { if (text.isNotBlank() && !busy && allowSend) { send(text.trim()); text = "" } }
    Row(Modifier.fillMaxWidth().imePadding().padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(text, { text = it.take(32768) }, placeholder = { Text("Tell me what's on your mind…") }, modifier = Modifier.weight(1f).testTag("$prefix.input"), maxLines = 6,
            shape = RoundedCornerShape(26.dp), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send), keyboardActions = KeyboardActions(onSend = { submit() }))
        FilledIconButton(onClick = { if (busy) cancel() else submit() }, enabled = busy || (text.isNotBlank() && allowSend), modifier = Modifier.size(52.dp).testTag(if (busy) "$prefix.cancel" else "$prefix.send")) {
            Icon(if (busy) Icons.Outlined.Stop else Icons.AutoMirrored.Outlined.Send, if (busy) "Cancel reply" else "Send message")
        }
    }
}
@Composable fun TasksScreen(vm: AppViewModel, state: AppState, go: (String) -> Unit) {
    var create by remember { mutableStateOf(false) }
    var prompt by rememberSaveable { mutableStateOf("") }
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
        Column { OutlinedTextField(prompt, { prompt = it.take(4000) }, label = { Text("Describe your task") }, minLines = 3, modifier = Modifier.testTag("tasks.prompt")); ErrorNotice(state.errors["createTask"]) }
    }, confirmButton = { TextButton(onClick = { vm.createTask(prompt.trim()) { id -> create = false; prompt = ""; go("task/$id") } }, enabled = prompt.isNotBlank() && "createTask" !in state.busy, modifier = Modifier.testTag("tasks.create")) { Text("Create task") } }, dismissButton = { TextButton(onClick = { create = false }) { Text("Cancel") } })
}
