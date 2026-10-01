package ai.impo.ui

import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.impo.client.*
import ai.impo.data.AppState
import ai.impo.data.AppViewModel
import ai.impo.nativebridge.NativeBridge
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import java.time.LocalDate

@Composable fun BriefScreen(vm: AppViewModel, state: AppState, go: (String) -> Unit) {
    var date by rememberSaveable { mutableStateOf("") }
    var filter by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<Brief?>(null) }
    Column(Modifier.fillMaxSize()) {
        PageHeader("Brief", "A fresh perspective on your day.", actions = {
            IconButton(onClick = { filter = !filter }) { Icon(Icons.Outlined.DateRange, "Filter Brief by date") }
            IconButton(onClick = { go("brief-settings") }, modifier = Modifier.testTag("brief.settings")) { Icon(Icons.Outlined.Tune, "Brief settings") }
            IconButton(onClick = { vm.refreshBriefs(date = date.ifBlank { null }) }) { Icon(Icons.Outlined.Refresh, "Refresh Brief") }
        })
        if (filter) Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(date, { date = it.take(10) }, label = { Text("Date · YYYY-MM-DD") }, singleLine = true, modifier = Modifier.weight(1f))
            TextButton(onClick = { vm.refreshBriefs(date = date.ifBlank { null }) }, enabled = date.isBlank() || runCatching { LocalDate.parse(date) }.isSuccess) { Text("Apply") }
        }
        BusyLine("briefs" in state.busy)
        ErrorNotice(state.errors["briefs"], { vm.refreshBriefs(date = date.ifBlank { null }) })
        LazyColumn(Modifier.fillMaxSize().testTag("brief.list"), contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
            if (state.briefs.isEmpty() && "briefs" !in state.busy) item { EmptyState("A little perspective, when it's time", "Your editions will appear here at the times you choose.", "Set up Brief", { go("brief-settings") }) }
            items(state.briefs, key = { it.id }) { brief -> BriefEdition(brief, go, { deleting = brief }) }
            if (state.briefCursor != null) item { TextButton(onClick = { vm.refreshBriefs(more = true, date = date.ifBlank { null }) }, enabled = "briefs" !in state.busy) { Text("Earlier editions") } }
        }
    }
    deleting?.let { brief -> ConfirmRemoval("Delete this Brief?", "This edition will be removed from your history.", { deleting = null }) { vm.deleteBrief(brief.id); deleting = null } }
}

@Composable private fun BriefEdition(brief: Brief, go: (String) -> Unit, remove: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var exporting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var share by remember { mutableStateOf(false) }
    fun export(pdf: Boolean) {
        share = false; exporting = true
        scope.launch {
            try {
                val uri = exportBrief(context, brief, pdf)
                val intent = Intent(Intent.ACTION_SEND).setType(if (pdf) "application/pdf" else "image/png").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                context.startActivity(Intent.createChooser(intent, "Share Brief"))
            } catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (e: Exception) { error = e.message ?: "Couldn't export this edition." }
            finally { exporting = false }
        }
    }
    Column(Modifier.fillMaxWidth().testTag("brief.${brief.id}"), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) { SectionLabel(brief.label); Text(brief.localDate, color = Muted, style = MaterialTheme.typography.bodySmall) }
            Box {
                IconButton(onClick = { share = true }, enabled = brief.visibleContent != null && !exporting) { Icon(Icons.Outlined.IosShare, "Share Brief") }
                DropdownMenu(share, { share = false }) {
                    DropdownMenuItem(text = { Text("Share as PDF") }, onClick = { export(true) })
                    DropdownMenuItem(text = { Text("Share as image") }, onClick = { export(false) })
                }
            }
            IconButton(onClick = remove) { Icon(Icons.Outlined.DeleteOutline, "Delete Brief") }
        }
        BusyLine(exporting)
        ErrorNotice(error)
        val content = brief.visibleContent
        if (content == null) PaperCard(Modifier.fillMaxWidth()) {
            Text(when (brief.status) { "failed" -> "This edition couldn't be prepared"; "withdrawn" -> "This edition is no longer available"; "pending", "running", "queued", "generating" -> "Your Brief is taking shape"; else -> humanStatus(brief.status) }, style = MaterialTheme.typography.titleLarge)
            Text(when (brief.status) { "failed" -> "A later edition will appear at your next scheduled time."; "withdrawn" -> "An original source was removed. Your remaining editions are still here."; else -> "Refresh to check for an update." }, color = Muted)
        } else {
            Text(content.title, style = MaterialTheme.typography.headlineLarge)
            RichResponse(content.summary, showActions = false)
            content.cards.forEach { card -> PaperCard(Modifier.fillMaxWidth()) {
                SectionLabel(card.eyebrow)
                Text(card.title, style = MaterialTheme.typography.titleLarge)
                RichResponse(card.body, showActions = false)
                card.bullets.forEach { RichResponse("• $it", showActions = false) }
                card.links.forEach { link -> if (link.url.startsWith("https://") || link.url.startsWith("http://")) TextButton(onClick = { openWeb(context, link.url) }) { Text(link.title) } }
                brief.sources.filter { it.id in card.sourceIds }.forEach { source ->
                    TextButton(onClick = { go("source/${brief.id}/${source.recordId}") }, modifier = Modifier.testTag("brief.source.${source.recordId}")) { Icon(Icons.Outlined.FormatQuote, null); Spacer(Modifier.width(6.dp)); Text(source.title) }
                }
            } }
        }
    }
}

@Composable fun MemoriesScreen(vm: AppViewModel, state: AppState, go: (String) -> Unit) {
    var about by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        PageHeader("Memories", "The little things, kept close.", actions = {
            IconButton(onClick = { if (about) vm.refreshMemories() else vm.refreshEcho() }) { Icon(Icons.Outlined.Refresh, "Refresh memories") }
        })
        Row(Modifier.padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FilterChip(!about, { about = false }, { Text("Echo") }, modifier = Modifier.testTag("memories.echo"))
            FilterChip(about, { about = true }, { Text("About you") }, modifier = Modifier.testTag("memories.about"))
        }
        if (about) AboutYou(vm, state, go) else EchoTimelineScreen(vm, state, go)
    }
}
@Composable private fun AboutYou(vm: AppViewModel, state: AppState, go: (String) -> Unit) {
    var deleting by remember { mutableStateOf<Memory?>(null) }
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(state.memoryCategory == null, { vm.refreshMemories(null) }, { Text("All · ${state.memorySummary.total}") })
        state.memorySummary.categories.forEach { (category, count) -> FilterChip(state.memoryCategory == category, { vm.refreshMemories(category) }, { Text("${humanStatus(category)} · $count") }) }
    }
    BusyLine("memories" in state.busy)
    ErrorNotice(state.errors["memories"], { vm.refreshMemories() })
    LazyColumn(Modifier.fillMaxSize().testTag("memories.list"), contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (state.memories.isEmpty() && "memories" !in state.busy) item { EmptyState("Getting to know you", "As you talk and collect Echoes, useful details will appear here. You can forget a memory at any time.") }
        items(state.memories, key = { it.id }) { memory -> PaperCard(Modifier.fillMaxWidth().testTag("memory.${memory.id}")) {
            SelectionContainer { Text(memory.content, style = MaterialTheme.typography.bodyLarge) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(memory.categories.joinToString(" · ") { humanStatus(it) }, color = Muted, style = MaterialTheme.typography.labelSmall, modifier = Modifier.weight(1f))
                IconButton(onClick = { deleting = memory }) { Icon(Icons.Outlined.DeleteOutline, "Forget memory") }
            }
            memory.sourceIds.filter { it.startsWith("echo:") }.forEach { source -> TextButton(onClick = { go("echo/${source.removePrefix("echo:")}") }) { Text("View original Echo") } }
            if (memory.sourceIds.any { it.startsWith("chat:") }) Text("From your conversations", color = Muted, style = MaterialTheme.typography.labelSmall)
        } }
        if (state.memoryCursor != null) item { TextButton(onClick = { vm.refreshMemories(more = true) }, enabled = "memories" !in state.busy) { Text("More memories") } }
    }
    deleting?.let { memory -> ConfirmRemoval("Forget this memory?", "This removes the saved detail. Its original conversation or Echo stays in your history.", { deleting = null }) { vm.forgetMemory(memory.id); deleting = null } }
}

private data class TimelineRow(val key: String, val date: String? = null, val recordId: String? = null)
@Composable private fun EchoTimelineScreen(vm: AppViewModel, state: AppState, go: (String) -> Unit) {
    val recording by NativeBridge.recording.collectAsStateWithLifecycle()
    val list = rememberLazyListState()
    var dates by remember { mutableStateOf(false) }
    var requestedDate by remember { mutableStateOf<String?>(null) }
    val rows = remember(state.timeline) { state.timeline?.days.orEmpty().flatMap { day -> listOf(TimelineRow("day:${day.date}", date = day.date)) + day.ids.map { TimelineRow(it, recordId = it) } } }
    val recordsByKey = remember(rows) { rows.associateBy { it.key } }
    LaunchedEffect(list, rows) {
        snapshotFlow { list.layoutInfo.visibleItemsInfo.mapNotNull { recordsByKey[it.key]?.recordId } }.distinctUntilChanged().collect { visible -> vm.hydrate(visible) }
    }
    LaunchedEffect(state.records.keys, state.recordErrors) {
        vm.hydrate(list.layoutInfo.visibleItemsInfo.mapNotNull { recordsByKey[it.key]?.recordId })
    }
    LaunchedEffect(requestedDate, rows, state.records.keys, state.recordErrors) {
        val date = requestedDate ?: return@LaunchedEffect
        val day = state.timeline?.days?.firstOrNull { it.date == date }
        if (day == null) { requestedDate = null; return@LaunchedEffect }
        // Position against hydrated card heights. Jumping to short placeholders can clamp
        // the list to a different anchor before the destination's real content arrives.
        if (day.ids.take(15).any { it !in state.records && it !in state.recordErrors }) return@LaunchedEffect
        val index = rows.indexOfFirst { it.date == date }
        if (index >= 0) {
            withFrameNanos { }
            list.scrollToItem(index)
        }
        requestedDate = null
    }
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) { RecordButton(vm, state.profile) }
        Box {
            TextButton(onClick = { dates = true }, enabled = !state.timeline?.days.isNullOrEmpty(), modifier = Modifier.testTag("echo.dates")) { Icon(Icons.Outlined.DateRange, null); Text("Jump to date") }
            DropdownMenu(dates, { dates = false }, modifier = Modifier.heightIn(max = 360.dp)) {
                state.timeline?.days?.forEach { day -> DropdownMenuItem(text = { Text("${day.date} · ${day.ids.size}") }, onClick = {
                    dates = false
                    requestedDate = day.date
                    vm.hydrate(day.ids.take(15), retry = true)
                }) }
            }
        }
    }
    if (recording.isRecording || recording.isPaused) PaperCard(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp)) {
        Text(when { recording.isPaused -> "Take your time. Echo is paused."; recording.speech -> "Listening to your words…"; else -> "Ready when you are." }, color = Forest)
        LinearProgressIndicator(progress = { recording.level.coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth(), color = Forest, trackColor = Sage)
    }
    if (recording.pendingBatches > 0) Row(Modifier.padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("${recording.pendingBatches} recording batches waiting to upload", color = Muted, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = { NativeBridge.retryUploads(vm.app) }) { Text("Retry") }
    }
    BusyLine(requestedDate != null)
    ErrorNotice(state.errors["echo"], { vm.refreshEcho() })
    LazyColumn(Modifier.fillMaxSize().testTag("echo.list"), state = list, contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (rows.isEmpty()) item(key = "echo.placeholder") {
            EchoTimelinePlaceholder(loaded = state.timeline != null, refreshing = "echo" in state.busy)
        }
        items(rows, key = { it.key }, contentType = { if (it.date != null) "date" else "echo" }) { row ->
            if (row.date != null) SectionLabel(row.date) else {
                val record = state.records[row.recordId]
                if (record != null) PaperCard(Modifier.fillMaxWidth().clickable { go("echo/${record.id}") }.testTag("echo.${record.id}")) {
                    Row { Text(shortDate(record.startedAt), color = Muted, style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f)); Text(humanStatus(record.status), color = Muted, style = MaterialTheme.typography.labelSmall) }
                    Text(record.transcript.ifBlank { when (record.status) { "failed" -> "Transcription couldn't finish. Open to try again."; "transcribed" -> "No speech was transcribed."; else -> "Your recording is being transcribed…" } }, maxLines = 5, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
                    record.location?.let { location -> val place = location.label ?: location.spans.firstOrNull()?.let { listOfNotNull(it.district, it.city).joinToString(", ") }; if (!place.isNullOrBlank()) Text(place, style = MaterialTheme.typography.labelSmall, color = Forest) }
                } else if (row.recordId in state.recordErrors) ErrorNotice("Couldn't load this Echo.") { vm.hydrate(listOf(row.recordId!!), retry = true) }
                else PaperCard(Modifier.fillMaxWidth()) { Text("Loading Echo…", color = Muted) }
            }
        }
    }
}

/** A successful empty index stays visible while later refreshes run or fail. */
@Composable internal fun EchoTimelinePlaceholder(loaded: Boolean, refreshing: Boolean) {
    when {
        loaded -> Box(Modifier.fillMaxWidth().testTag("echo.empty")) {
            EmptyState("Keep a passing thought", "Record a thought, a conversation, or an idea. Your transcribed Echoes will collect here.")
        }
        refreshing -> Row(Modifier.fillMaxWidth().padding(vertical = 24.dp).testTag("echo.loading"),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            CircularProgressIndicator(Modifier.size(22.dp), color = Forest, strokeWidth = 2.dp)
            Text("Loading your timeline…", color = Muted)
        }
        // Before the first request, or after its failure, there is no confirmed empty
        // result. The screen's existing error notice supplies the retry action.
    }
}

@Composable fun EchoDetailScreen(vm: AppViewModel, state: AppState, id: String, back: () -> Unit) {
    var deleting by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf(false) }
    val record = state.selectedRecord?.takeIf { it.id == id }
    var label by rememberSaveable(record?.id, record?.location?.label) { mutableStateOf(record?.location?.label.orEmpty()) }
    Column(Modifier.fillMaxSize()) {
        PageHeader("Echo", back = back, actions = {
            IconButton(onClick = { vm.openRecord(id) }) { Icon(Icons.Outlined.Refresh, "Refresh Echo") }
            IconButton(onClick = { deleting = true }, enabled = record != null) { Icon(Icons.Outlined.DeleteOutline, "Delete Echo") }
        })
        BusyLine("record" in state.busy)
        ErrorNotice(state.errors["record"], { vm.openRecord(id) })
        if (record != null) Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(22.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            SectionLabel(shortDate(record.startedAt))
            Text(humanStatus(record.status), color = Muted)
            if (record.transcript.isNotBlank()) SelectionContainer { Text(record.transcript, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("echo.transcript")) }
            else Text(when (record.status) { "transcribed" -> "No speech was transcribed."; "failed" -> "Transcription couldn't finish."; else -> "Your recording is being transcribed…" }, color = Muted)
            record.error?.let { ErrorNotice(it.message) }
            if (record.status == "failed") record.batchId?.let { batch -> OutlinedButton(onClick = { vm.retryTranscription(batch) }) { Text("Retry transcription") } }
            HorizontalDivider(color = Border)
            Text(record.location?.label ?: "Add a place label", style = MaterialTheme.typography.titleLarge)
            record.location?.spans?.map { listOfNotNull(it.district, it.city, it.country).distinct().joinToString(", ") }?.distinct()?.forEach { Text(it, color = Muted) }
            TextButton(onClick = { editing = true }, modifier = Modifier.testTag("echo.label")) { Icon(Icons.Outlined.EditLocationAlt, null); Spacer(Modifier.width(6.dp)); Text("Edit place label") }
        }
    }
    if (editing) AlertDialog(onDismissRequest = { editing = false }, title = { Text("Place label") }, text = { Column {
        OutlinedTextField(label, { label = it.take(80) }, label = { Text("Home, office, or somewhere else") }, modifier = Modifier.testTag("echo.label.input"))
        Row { TextButton(onClick = { label = "Home" }) { Text("Home") }; TextButton(onClick = { label = "Office" }) { Text("Office") }; TextButton(onClick = { label = "" }) { Text("Clear") } }
    } }, confirmButton = { TextButton(onClick = { vm.labelRecord(id, label.trim().ifEmpty { null }); editing = false }, modifier = Modifier.testTag("echo.label.save")) { Text("Save") } }, dismissButton = { TextButton(onClick = { editing = false }) { Text("Cancel") } })
    if (deleting) ConfirmRemoval("Delete this Echo?", "The recording and transcript will be removed. Brief editions that rely on it will also be invalidated.", { deleting = false }) { deleting = false; vm.deleteRecord(id, back) }
}

@Composable fun SourceScreen(vm: AppViewModel, state: AppState, back: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        PageHeader("Original source", back = back)
        BusyLine("source" in state.busy)
        ErrorNotice(state.errors["source"])
        state.source?.let { source -> Column(Modifier.verticalScroll(rememberScrollState()).padding(22.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(source.title, style = MaterialTheme.typography.headlineMedium)
            Text(shortDate(source.occurredAt), color = Muted)
            SelectionContainer { Text(source.text ?: "This source has no available transcript.", style = MaterialTheme.typography.bodyLarge) }
            source.location?.label?.let { Text(it, color = Forest) }
        } }
    }
}

@Composable private fun ConfirmRemoval(title: String, detail: String, dismiss: () -> Unit, remove: () -> Unit) {
    AlertDialog(onDismissRequest = dismiss, title = { Text(title) }, text = { Text(detail) }, confirmButton = { TextButton(onClick = remove, modifier = Modifier.testTag("confirm.delete")) { Text("Delete") } }, dismissButton = { TextButton(onClick = dismiss) { Text("Keep") } })
}
