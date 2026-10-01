package ai.impo.ui

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import ai.impo.client.*
import ai.impo.data.AppState
import ai.impo.data.AppViewModel
import java.time.*
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.UUID

private fun scheduleDate(value: String?, zone: String): String = value?.let {
    runCatching { Instant.parse(it).atZone(ZoneId.of(zone)).format(DateTimeFormatter.ofPattern("MMM d, yyyy · HH:mm", Locale.ENGLISH)) }.getOrDefault("No upcoming run")
} ?: "No upcoming run"

@Composable fun ScheduledTasksScreen(vm: AppViewModel, state: AppState, go: (String) -> Unit, back: () -> Unit) {
    LaunchedEffect(state.account?.requestScope) { vm.refreshSchedules() }
    Column(Modifier.fillMaxSize()) {
        PageHeader("Scheduled tasks", "Make time for what matters.", back = back, actions = {
            IconButton(onClick = { vm.refreshSchedules() }) { Icon(Icons.Outlined.Refresh, "Refresh schedules") }
            IconButton(onClick = { go("schedule/new") }, modifier = Modifier.testTag("schedule.new")) { Icon(Icons.Outlined.Add, "Schedule a task") }
        })
        BusyLine("schedules" in state.busy)
        ErrorNotice(state.errors["schedules"], { vm.refreshSchedules() })
        LazyColumn(contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.fillMaxSize()) {
            item { Text("Give a task a time. Impo takes it from there, even when the app is closed.", color = Muted) }
            if (state.schedules.isEmpty() && "schedules" !in state.busy) item {
                EmptyState("A little help, on repeat", "Run a task once, every day or on the days you choose.", "Schedule a task", { go("schedule/new") })
            }
            items(state.schedules, key = { it.id }) { value ->
                PaperCard(Modifier.fillMaxWidth().clickable { go("schedule/${value.id}") }.testTag("schedule.${value.id}")) {
                    Text(value.title, style = MaterialTheme.typography.titleLarge)
                    Text(if (!value.enabled) "Paused" else if (value.nextRunAt == null) "Completed" else "Next: ${scheduleDate(value.nextRunAt, value.schedule.timeZone)}", color = Forest)
                    Text("${value.schedule.frequency.replaceFirstChar { it.uppercase() }} · ${value.schedule.timeZone}", color = Muted, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable fun ScheduledTaskEditor(vm: AppViewModel, state: AppState, id: String, go: (String) -> Unit, back: () -> Unit) {
    val owner = state.account?.requestScope
    val context = LocalContext.current
    var title by remember(id, owner) { mutableStateOf("") }
    var goal by remember(id, owner) { mutableStateOf("") }
    var frequency by remember(id, owner) { mutableStateOf("daily") }
    var zone by remember(id, owner) { mutableStateOf(ZoneId.systemDefault().id) }
    var date by remember(id, owner) { mutableStateOf(LocalDate.now().plusDays(1)) }
    var time by remember(id, owner) { mutableStateOf(LocalTime.of(9, 0)) }
    var days by remember(id, owner) { mutableStateOf(listOf(1, 2, 3, 4, 5)) }
    var enabled by remember(id, owner) { mutableStateOf(true) }
    var ready by remember(id, owner) { mutableStateOf(id == "new") }
    var deleting by remember(id, owner) { mutableStateOf(false) }
    var requestId by remember(id, owner) { mutableStateOf(UUID.randomUUID().toString()) }
    var pending by remember(id, owner) { mutableStateOf<ScheduledTaskInput?>(null) }
    var source by remember(id, owner) { mutableStateOf<ScheduledTask?>(null) }
    val saving = "scheduleSave" in state.busy
    val editable = ready && !saving && pending == null
    val validZone = runCatching { ZoneId.of(zone) }.getOrNull()
    val at = validZone?.let { LocalDateTime.of(date, time).atZone(it).toInstant() }
    val input = ScheduledTaskInput(title.trim(), goal.trim(), TaskSchedule(frequency, zone,
        if (frequency == "once") at?.toString() else null, if (frequency == "once") null else time.format(DateTimeFormatter.ofPattern("HH:mm")),
        if (frequency == "weekly") days.sorted() else emptyList()), enabled)
    val valid = title.isNotBlank() && title.length <= 120 && goal.isNotBlank() && goal.length <= 4000 && validZone != null &&
        (frequency != "weekly" || days.isNotEmpty()) && (!enabled || frequency != "once" || at?.isAfter(Instant.now()) == true || input == source?.input)
    fun load() {
        ready = false; source = null
        vm.openSchedule(id) { value ->
            source = value
            title = value.title; goal = value.goal; frequency = value.schedule.frequency; zone = value.schedule.timeZone; enabled = value.enabled
            days = value.schedule.weekdays.ifEmpty { listOf(1, 2, 3, 4, 5) }
            if (value.schedule.runAt != null) {
                val local = Instant.parse(value.schedule.runAt).atZone(ZoneId.of(zone)); date = local.toLocalDate(); time = local.toLocalTime().withSecond(0).withNano(0)
            } else { time = LocalTime.parse(value.schedule.time ?: "09:00") }
            ready = true
        }
    }
    LaunchedEffect(id, owner) { vm.dismissError("scheduleSave"); if (id != "new") load() }
    BackHandler(enabled = saving) { /* Keep the submitted command attached until the response arrives. */ }
    Column(Modifier.fillMaxSize()) {
        PageHeader(if (id == "new") "Schedule a task" else "Scheduled task", back = { if (!saving) back() }, actions = {
            TextButton(onClick = {
                val command = pending ?: input; pending = command
                vm.saveSchedule(source, requestId, command, rejected = { pending = null; requestId = UUID.randomUUID().toString() }, saved = back)
            }, enabled = ready && !saving && (pending != null || valid), modifier = Modifier.testTag("schedule.save")) { Text(if (saving) "Saving…" else if (pending != null) "Retry save" else "Save") }
        })
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            ErrorNotice(state.errors["scheduleDetail"], { load() })
            ErrorNotice(state.errors["scheduleSave"])
            if (pending != null && !saving) Text("Couldn't confirm the save. Retry to safely recover the same request.", color = Muted)
            if (source != null && pending == null && state.errors["scheduleSave"] != null) TextButton(onClick = { load() }) { Text("Reload schedule") }
            if (!ready) CircularProgressIndicator()
            PaperCard {
                OutlinedTextField(title, { title = it }, label = { Text("A short title") }, enabled = editable, singleLine = true,
                    modifier = Modifier.fillMaxWidth().testTag("schedule.title"), isError = title.length > 120)
                OutlinedTextField(goal, { goal = it }, label = { Text("What should Impo do?") }, enabled = editable, minLines = 4,
                    modifier = Modifier.fillMaxWidth().testTag("schedule.goal"), isError = goal.length > 4000)
                Text("Include the details each run will need. Each result gets its own task conversation.", color = Muted, style = MaterialTheme.typography.bodySmall)
            }
            SectionLabel("Schedule")
            PaperCard {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("once" to "Once", "daily" to "Daily", "weekly" to "Weekly").forEach { (value, label) ->
                        FilterChip(frequency == value, { frequency = value }, { Text(label) }, enabled = editable, modifier = Modifier.testTag("schedule.frequency.$value"))
                    }
                }
                if (frequency == "once") TextButton(onClick = {
                    DatePickerDialog(context, { _, year, month, day -> date = LocalDate.of(year, month + 1, day) }, date.year, date.monthValue - 1, date.dayOfMonth).show()
                }, enabled = editable) { Text("Date: ${date.format(DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.ENGLISH))}") }
                TextButton(onClick = { TimePickerDialog(context, { _, hour, minute -> time = LocalTime.of(hour, minute) }, time.hour, time.minute, true).show() }, enabled = editable) { Text("Time: $time") }
                if (frequency == "weekly") {
                    listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday").forEachIndexed { index, label ->
                        val day = index + 1
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(label, Modifier.weight(1f))
                            Switch(day in days, { checked -> days = if (checked) (days + day).distinct() else days - day }, enabled = editable)
                        }
                    }
                    if (days.isEmpty()) Text("Choose at least one day.", color = MaterialTheme.colorScheme.error)
                }
                OutlinedTextField(zone, { zone = it }, label = { Text("Time zone") }, supportingText = { Text("For example, Asia/Shanghai") }, singleLine = true,
                    enabled = editable, isError = validZone == null, modifier = Modifier.fillMaxWidth())
                TextButton(onClick = { zone = ZoneId.systemDefault().id }, enabled = editable) { Text("Use this phone's time zone") }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("Schedule enabled", Modifier.weight(1f))
                    Switch(enabled, { enabled = it }, enabled = editable, modifier = Modifier.testTag("schedule.enabled"))
                }
                Text("The schedule keeps this time zone when you travel. If a run is still working, the next occurrence is skipped.", color = Muted, style = MaterialTheme.typography.bodySmall)
                if (enabled && frequency == "once" && at?.isAfter(Instant.now()) != true && input != source?.input) Text("Choose a future time.", color = MaterialTheme.colorScheme.error)
            }
            source?.let { saved ->
                SectionLabel("Next run")
                Text(if (saved.enabled) scheduleDate(saved.nextRunAt, saved.schedule.timeZone) else "Paused")
                SectionLabel("Run history")
                ErrorNotice(state.errors["scheduleHistory"], { vm.loadScheduleHistory(id) })
                if (state.scheduleRuns.isEmpty() && "scheduleHistory" !in state.busy) Text("No runs yet", color = Muted)
                state.scheduleRuns.forEach { run ->
                    PaperCard(Modifier.fillMaxWidth().clickable(enabled = run.taskId != null) { run.taskId?.let { go("task/$it") } }) {
                        Text(scheduleDate(run.scheduledAt, saved.schedule.timeZone))
                        Text(if (run.status == "skipped_overlap") "Skipped — previous run still working" else run.status.replace('_', ' ').replaceFirstChar { it.uppercase() }, color = Muted)
                    }
                }
                if ("scheduleHistory" in state.busy) CircularProgressIndicator()
                if (state.scheduleCursor != null) TextButton(onClick = { vm.loadScheduleHistory(id) }, enabled = "scheduleHistory" !in state.busy) { Text("Load earlier runs") }
                TextButton(onClick = { deleting = true }, enabled = !saving, modifier = Modifier.testTag("schedule.delete")) { Text("Delete schedule", color = MaterialTheme.colorScheme.error) }
                Text("Pausing or deleting stops future runs. Tasks already started keep their results.", color = Muted, style = MaterialTheme.typography.bodySmall)
            }
            Text("Control completion alerts in Settings → Notifications → Scheduled tasks.", color = Muted, style = MaterialTheme.typography.bodySmall)
        }
    }
    if (deleting && source != null) AlertDialog(onDismissRequest = { deleting = false }, title = { Text("Delete this schedule?") },
        text = { Text("Future runs will stop. Existing task results will stay in Tasks.") },
        confirmButton = { TextButton(onClick = { deleting = false; source?.let { vm.deleteSchedule(it, back) } }) { Text("Delete schedule") } },
        dismissButton = { TextButton(onClick = { deleting = false }) { Text("Cancel") } })
}
