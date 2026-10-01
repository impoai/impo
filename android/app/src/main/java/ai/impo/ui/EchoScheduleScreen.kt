package ai.impo.ui

import android.app.TimePickerDialog
import android.content.Intent
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.impo.client.EchoSchedule
import ai.impo.data.AppViewModel
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import java.time.ZoneId

@Composable fun EchoScheduleScreen(vm: AppViewModel, back: () -> Unit) {
    val controller = vm.app.echoSchedule
    val state by controller.state.collectAsStateWithLifecycle()
    val push by vm.app.push.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var draft by remember { mutableStateOf(EchoSchedule(timeZone = ZoneId.systemDefault().id)) }
    var ready by remember { mutableStateOf(false) }
    fun loadDraft() { draft = controller.state.value.schedule.let { if (it.revision == null) it.copy(timeZone = ZoneId.systemDefault().id) else it }; ready = controller.state.value.loaded }
    LaunchedEffect(Unit) { controller.refresh(force = true); if (!ready) loadDraft(); vm.app.push.refresh() }
    LaunchedEffect(state.loaded) { if (state.loaded && !ready) loadDraft() }
    Column(Modifier.fillMaxSize()) {
        PageHeader("Echo schedule", back = back, actions = {
            TextButton(onClick = { scope.launch(Dispatchers.Main.immediate) { if (controller.save(draft)) back() } }, enabled = ready && draft.isValid && !state.saving,
                modifier = Modifier.testTag("echo.schedule.save")) { Text(if (state.saving) "Saving…" else "Save") }
        })
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            PaperCard {
                SettingsToggle("Enable Echo schedule", "A little nudge to capture your day. You'll choose when to start recording.", draft.enabled, "echo.schedule.enabled") {
                    if (!state.saving) draft = draft.copy(enabled = it)
                }
            }
            SectionLabel("Repeat")
            PaperCard {
                listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday").forEachIndexed { index, name ->
                    val day = index + 1
                    Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        Text(name, Modifier.weight(1f))
                        Switch(day in draft.weekdays, { enabled -> draft = draft.copy(weekdays = (draft.weekdays.filterNot { it == day } + if (enabled) listOf(day) else emptyList()).sorted()) },
                            enabled = !state.saving, modifier = Modifier.testTag("echo.schedule.day.$day"))
                    }
                }
                if (draft.weekdays.isEmpty()) Text("Choose at least one day.", color = MaterialTheme.colorScheme.error)
            }
            SectionLabel("Times")
            PaperCard {
                EchoClock("Remind me to start", draft.reminderTime, "echo.schedule.reminder", !state.saving) { draft = draft.copy(reminderTime = it) }
                SettingsToggle("Stop Echo automatically", "End any ongoing Echo recording at the next stop time on a selected day, including while your phone is locked.", draft.autoStop, "echo.schedule.auto-stop") { if (!state.saving) draft = draft.copy(autoStop = it) }
                if (draft.autoStop) EchoClock("Stop at", draft.stopTime, "echo.schedule.stop", !state.saving) { draft = draft.copy(stopTime = it) }
                if (draft.autoStop && draft.stopTime <= draft.reminderTime) Text("Choose a stop time after the reminder.", color = MaterialTheme.colorScheme.error)
                Text("Reminders open Echo without starting the microphone. You can always stop recording sooner.", color = Muted, style = MaterialTheme.typography.bodySmall)
            }
            SectionLabel("Time zone")
            PaperCard {
                Text(draft.timeZone.replace('_', ' '), style = MaterialTheme.typography.titleMedium)
                Text("The schedule stays in this time zone when you travel.", color = Muted)
                TextButton(onClick = { draft = draft.copy(timeZone = ZoneId.systemDefault().id) }, enabled = !state.saving) { Text("Use this phone's time zone") }
            }
            if (!push.preferences.echo) Text("Echo reminders are off in Notifications. Your automatic stop time still applies.", color = Muted)
            if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) PaperCard {
                Text("Allow notifications on this phone to receive Echo reminders.")
                TextButton(onClick = { context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) }) { Text("Open notification settings") }
            }
            ErrorNotice(state.error) { scope.launch(Dispatchers.Main.immediate) { controller.refresh(force = true); loadDraft() } }
            if (!ready && state.error == null) CircularProgressIndicator()
        }
    }
}

@Composable private fun EchoClock(title: String, value: String, tag: String, enabled: Boolean, change: (String) -> Unit) {
    val context = LocalContext.current
    Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        Text(title, Modifier.weight(1f))
        OutlinedButton(onClick = {
            val (hour, minute) = value.split(':').map(String::toInt)
            TimePickerDialog(context, { _, h, m -> change("%02d:%02d".format(java.util.Locale.ROOT, h, m)) }, hour, minute, true).show()
        }, enabled = enabled, modifier = Modifier.testTag(tag)) { Text(value) }
    }
}
