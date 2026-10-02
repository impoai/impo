package ai.impo.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.Saver
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.health.connect.client.HealthConnectClient
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.impo.BuildConfig
import ai.impo.client.BriefLocation
import ai.impo.client.BriefSettings
import ai.impo.client.BriefSlot
import ai.impo.client.Connector
import androidx.compose.foundation.selection.selectable
import ai.impo.client.ProtocolJson
import ai.impo.client.wireTimestamp
import ai.impo.data.AppState
import ai.impo.data.AppViewModel
import ai.impo.nativebridge.NativeBridge
import ai.impo.nativebridge.BriefCityReader
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import java.util.UUID

@Composable fun SettingsScreen(vm: AppViewModel, state: AppState, go: (String) -> Unit, back: () -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(state.account?.id) { vm.retryProfile() }
    val scope = rememberCoroutineScope()
    val recording by NativeBridge.recording.collectAsStateWithLifecycle()
    var signOut by remember { mutableStateOf(false) }
    var deletion by remember { mutableStateOf(false) }
    var locationConsent by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var notifications by remember { mutableStateOf(NotificationManagerCompat.from(context).areNotificationsEnabled()) }
    var versionTaps by remember { mutableIntStateOf(0) }
    var debug by remember { mutableStateOf(false) }
    var endpoint by rememberSaveable { mutableStateOf(state.account?.baseUrl.orEmpty()) }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        notifications = NotificationManagerCompat.from(context).areNotificationsEnabled()
    }
    val locationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        val granted = grants[Manifest.permission.ACCESS_COARSE_LOCATION] == true || grants[Manifest.permission.ACCESS_FINE_LOCATION] == true
        if (granted) {
            NativeBridge.setRecordingLocation(context, true)
            vm.saveProfile(vm.state.value.profile.copy(recordingLocation = true))
        } else error = "Location wasn't allowed. Echo can still record without places."
    }
    OnResume { notifications = NotificationManagerCompat.from(context).areNotificationsEnabled() }
    fun launch(intent: Intent) { runCatching { context.startActivity(intent) }.onFailure { error = "No app is available to open this action." } }
    Column(Modifier.fillMaxSize()) {
        PageHeader("Settings", back = back)
        LazyColumn(Modifier.weight(1f).testTag("settings.list"), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            item {
                PaperCard(Modifier.fillMaxWidth()) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        AssistantAvatar(state.profile.avatar, 54)
                        Column(Modifier.weight(1f)) {
                            Text(state.profile.displayName.ifBlank { state.account?.name ?: "Your account" }, style = MaterialTheme.typography.titleLarge)
                            Text(state.account?.email ?: if (state.account?.development == true) "Local development account" else "Signed in", color = Muted)
                        }
                    }
                }
            }
            item {
                SectionLabel("Mode")
                PaperCard {
                    listOf(
                        "Balanced" to "DeepSeek V4.1 Flash · Fast and economical for everyday tasks.",
                        "Power" to "GPT-6 Sol · Stronger reasoning for complex work.",
                    ).forEach { (mode, description) ->
                        Row(Modifier.fillMaxWidth().selectable(
                            selected = state.profile.mode == mode,
                            enabled = "profile" !in state.busy,
                            role = androidx.compose.ui.semantics.Role.RadioButton,
                            onClick = { vm.saveProfile(state.profile.copy(mode = mode)) },
                        ).testTag("settings.mode.${mode.lowercase()}").padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = state.profile.mode == mode, onClick = null)
                            Column(Modifier.padding(start = 12.dp).weight(1f)) {
                                Text(mode, style = MaterialTheme.typography.titleMedium)
                                Text(description, style = MaterialTheme.typography.bodySmall, color = Muted)
                            }
                        }
                    }
                    Text("Applies to your next chat reply, task and Brief on all your devices. Work already running keeps its current model.", color = Muted, style = MaterialTheme.typography.bodySmall)
                    if ("profile" in state.busy) Text("Syncing your mode…", color = Muted)
                    ErrorNotice(state.errors["profile"], if ("profile" !in state.busy) vm::retryProfile else null)
                }
            }
            item {
                SectionLabel("Make it yours")
                PaperCard {
                    SettingsLink("Your assistant", state.profile.assistantName, Icons.Outlined.Face) { go("assistant") }
                    HorizontalDivider(color = Border)
                    SettingsLink("Connections", "Calendar, Health and your other apps", Icons.Outlined.Link, "settings.connections") { go("connections") }
                    HorizontalDivider(color = Border)
                    SettingsLink("Brief preferences", "Hours, language and local context", Icons.Outlined.WbSunny, "settings.brief") { go("brief-settings") }
                }
            }
            item {
                SectionLabel("Echo")
                PaperCard {
                    SettingsLink("Echo schedule", "Reminders and an optional stop time", Icons.Outlined.Schedule, "settings.echo-schedule") { go("echo-schedule") }
                    HorizontalDivider(color = Border)
                    SettingsToggle("Upload on Wi-Fi only", "Keep saved audio on this device until an unmetered Wi-Fi connection is available.", state.profile.wifiOnly, "settings.wifi") {
                        vm.saveProfile(state.profile.copy(wifiOnly = it))
                    }
                    HorizontalDivider(color = Border)
                    SettingsToggle("Add recording places", "Attach a resolved city or district while recording. Coordinates are never uploaded.", state.profile.recordingLocation, "settings.location") { enabled ->
                        if (enabled) locationConsent = true else {
                            NativeBridge.setRecordingLocation(context, false)
                            vm.saveProfile(state.profile.copy(recordingLocation = false))
                        }
                    }
                    Text("Place capture starts with your next recording or resume. Turning it off stops location capture immediately.", color = Muted, style = MaterialTheme.typography.bodySmall)
                    if (recording.pendingBatches > 0) {
                        Text("${recording.pendingBatches} audio ${if (recording.pendingBatches == 1) "batch is" else "batches are"} safely queued on this device.", color = Muted)
                        TextButton(onClick = { NativeBridge.retryUploads(context) }) { Text("Retry uploads") }
                    }
                    Text("Microphone access is requested when you start Echo. Recording never starts automatically after a restart.", color = Muted, style = MaterialTheme.typography.bodySmall)
                }
            }
            item {
                SectionLabel("Device")
                PaperCard {
                    SettingsLink("Notifications", if (notifications) "Allowed by Android" else "Off in Android", Icons.Outlined.NotificationsNone) {
                        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                        else launch(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                    }
                    NotificationCategories(vm)
                    Text("Chat and task alerts stay quiet while you're using Impo. Brief alerts do not change your generation plan. Echo recording controls remain available separately.", color = Muted, style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = { launch(appSettings(context)) }) { Text("Review Android permissions") }
                }
            }
            item {
                SectionLabel("About Impo")
                PaperCard {
                    SettingsLink("Privacy policy", "How your information is handled", Icons.Outlined.PrivacyTip) { openWeb(context, "https://impo.ai/privacy/") }
                    SettingsLink("Terms of use", null, Icons.Outlined.Description) { openWeb(context, "https://impo.ai/terms/") }
                    SettingsLink("Contact support", "cj@impo.ai", Icons.Outlined.Email) { launch(mail("Impo support", "Account: ${state.account?.email.orEmpty()}")) }
                    Text("Impo ${BuildConfig.VERSION_NAME}", color = Muted, modifier = Modifier.fillMaxWidth().clickable {
                        if (BuildConfig.DEBUG && ++versionTaps >= 5) debug = true
                    }.padding(vertical = 14.dp), style = MaterialTheme.typography.bodySmall)
                }
            }
            item {
                ErrorNotice(error ?: state.errors["account"])
                OutlinedButton(onClick = { signOut = true }, modifier = Modifier.fillMaxWidth().testTag("settings.signOut")) { Text("Sign out") }
                TextButton(onClick = { deletion = true }, modifier = Modifier.fillMaxWidth()) { Text("Delete account", color = MaterialTheme.colorScheme.error) }
                Spacer(Modifier.height(20.dp))
            }
        }
    }
    if (locationConsent) AlertDialog(onDismissRequest = { locationConsent = false }, title = { Text("Add places to Echo?") },
        text = { Text("While you record, Impo can resolve your location to a city or district and attach that place to your audio. Raw coordinates stay on this device. Approximate location is enough, and recording works without it.") },
        confirmButton = { TextButton(onClick = { locationConsent = false; locationPermission.launch(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION)) }) { Text("Choose location access") } },
        dismissButton = { TextButton(onClick = { locationConsent = false }) { Text("Not now") } })
    if (signOut) AlertDialog(onDismissRequest = { signOut = false }, title = { Text("Sign out?") },
        text = { Text("Echo recording will stop. Any audio waiting to upload stays on this device and can resume uploading when you sign back into this account.") },
        confirmButton = { TextButton(onClick = { signOut = false; vm.signOut() }) { Text("Sign out") } },
        dismissButton = { TextButton(onClick = { signOut = false }) { Text("Cancel") } })
    if (deletion) DeleteAccountDialog(vm) { deletion = false }
    if (debug && BuildConfig.DEBUG) AlertDialog(onDismissRequest = { debug = false }, title = { Text("Developer connection") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Switch to an explicitly configured local development API. This signs you into its development account.")
            OutlinedTextField(endpoint, { endpoint = it }, label = { Text("API URL") }, singleLine = true)
        }
    }, confirmButton = { TextButton(onClick = { scope.launch { runCatching { vm.auth.connectDevelopment(endpoint); debug = false }.onFailure { error = it.message } } }) { Text("Connect") } },
        dismissButton = { TextButton(onClick = { debug = false }) { Text("Cancel") } })
}

@Composable fun ConnectionsScreen(vm: AppViewModel, state: AppState, back: () -> Unit, onContinue: (() -> Unit)? = null) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var search by rememberSaveable { mutableStateOf("") }
    var calendarGranted by remember { mutableStateOf(vm.deviceAdapter.calendarGranted) }
    var contactsGranted by remember { mutableStateOf(vm.deviceAdapter.contactsGranted) }
    var healthGrants by remember { mutableStateOf(emptySet<String>()) }
    var healthAvailable by remember { mutableStateOf(vm.deviceAdapter.healthAvailable) }
    var consent by remember { mutableStateOf<String?>(null) }
    var disconnect by remember { mutableStateOf<Connector?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val deviceError by vm.devices.error.collectAsStateWithLifecycle()
    fun refreshNative() {
        calendarGranted = vm.deviceAdapter.calendarGranted; contactsGranted = vm.deviceAdapter.contactsGranted
        healthAvailable = vm.deviceAdapter.healthAvailable
        scope.launch { runCatching { vm.deviceAdapter.grantedHealthPermissions() }.onSuccess { healthGrants = it }.onFailure { error = "Health permissions couldn't refresh." } }
    }
    val calendarPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        calendarGranted = granted
        if (granted) vm.saveProfile(vm.state.value.profile.copy(calendarEnabled = true))
        else error = "Calendar access wasn't allowed. You can review it in Android settings."
    }
    val contactsPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        contactsGranted = granted
        if (granted) vm.saveProfile(vm.state.value.profile.copy(contactsEnabled = true))
        else error = "Contacts access wasn't allowed. Your other connections still work."
    }
    val healthPermission = rememberLauncherForActivityResult(vm.deviceAdapter.healthPermissionContract()) { granted ->
        healthGrants = granted
        if (granted.any { it in vm.deviceAdapter.healthPermissions }) vm.saveProfile(vm.state.value.profile.copy(healthEnabled = true))
        else error = "No Health read permissions were granted. Your other connections still work."
    }
    LaunchedEffect(Unit) { refreshNative(); vm.refreshConnectors() }
    OnResume { refreshNative(); vm.refreshConnectors() }
    val filtered = state.connectors.filter { search.isBlank() || it.name.contains(search, true) || it.toolkit.contains(search, true) || it.description?.contains(search, true) == true }
    Column(Modifier.fillMaxSize().then(if (onContinue != null) Modifier.safeDrawingPadding() else Modifier)) {
        PageHeader("Connections", if (onContinue != null) "Give Impo a little context. Every connection is optional." else "Choose the context your agent can use.", back) {
            IconButton(onClick = { refreshNative(); vm.refreshConnectors() }) { Icon(Icons.Outlined.Refresh, "Refresh connections") }
        }
        BusyLine("connectors" in state.busy)
        ErrorNotice(error)
        if (onContinue != null) ErrorNotice(state.errors["profile"], if ("profile" !in state.busy) vm::retryProfile else null)
        LazyColumn(Modifier.weight(1f).testTag("connections.list"), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            item {
                SectionLabel("On this Android device")
                PaperCard {
                    SettingsToggle("Calendar", when {
                        !state.profile.calendarEnabled -> "Not connected"
                        calendarGranted -> "Connected · read-only"
                        else -> "Permission needed in Android settings"
                    }, state.profile.calendarEnabled, "connections.calendar") { enabled ->
                        if (enabled) consent = "calendar" else vm.saveProfile(state.profile.copy(calendarEnabled = false))
                    }
                    Text("Your agent can read event titles, times, calendars and locations when you ask. Event notes are excluded; Impo cannot edit events.", color = Muted, style = MaterialTheme.typography.bodySmall)
                    if (state.profile.calendarEnabled && !calendarGranted) TextButton(onClick = { calendarPermission.launch(Manifest.permission.READ_CALENDAR) }) { Text("Review Calendar permission") }
                    HorizontalDivider(color = Border)
                    SettingsToggle("Health Connect", when {
                        !healthAvailable -> "Unavailable or needs an update on this device"
                        !state.profile.healthEnabled -> "Not connected"
                        healthGrants.containsAll(vm.deviceAdapter.healthPermissions) -> "Connected · four read permissions"
                        healthGrants.any { it in vm.deviceAdapter.healthPermissions } -> "Connected · some read permissions"
                        else -> "Read permissions needed"
                    }, state.profile.healthEnabled, "connections.health", enabled = healthAvailable || state.profile.healthEnabled) { enabled ->
                        if (enabled) consent = "health" else vm.saveProfile(state.profile.copy(healthEnabled = false))
                    }
                    Text("Read steps, active calories, heart rate and sleep. Missing samples stay unknown; Impo never treats missing health data as zero activity.", color = Muted, style = MaterialTheme.typography.bodySmall)
                    if (healthAvailable) TextButton(onClick = { consent = "health" }) { Text("Review Health permissions") }
                    else TextButton(onClick = { openWeb(context, "https://play.google.com/store/apps/details?id=com.google.android.apps.healthdata") }) { Text("Get Health Connect") }
                    HorizontalDivider(color = Border)
                    SettingsToggle("Contacts", when {
                        !state.profile.contactsEnabled -> "Not connected"
                        contactsGranted -> "Connected · read-only"
                        else -> "Permission needed in Android settings"
                    }, state.profile.contactsEnabled, "connections.contacts") { enabled ->
                        if (enabled) consent = "contacts" else vm.saveProfile(state.profile.copy(contactsEnabled = false))
                    }
                    Text("When you ask, your agent can search names, companies, email addresses, phone numbers and birthdays. Impo cannot edit contacts.", color = Muted, style = MaterialTheme.typography.bodySmall)
                    if (state.profile.contactsEnabled && !contactsGranted) TextButton(onClick = { contactsPermission.launch(Manifest.permission.READ_CONTACTS) }) { Text("Review Contacts permission") }
                    TextButton(onClick = { runCatching { context.startActivity(appSettings(context)) }.onFailure { error = "Couldn't open Android settings." } }) { Text("Open Android permissions") }
                    ErrorNotice(deviceError)
                }
            }
            item {
                SectionLabel("Your other apps")
                OutlinedTextField(search, { search = it }, modifier = Modifier.fillMaxWidth().testTag("connections.search"), singleLine = true,
                    label = { Text("Find an app") }, leadingIcon = { Icon(Icons.Outlined.Search, null) })
                Text("${state.connectors.size} apps available from the connected service directory.", color = Muted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
                ErrorNotice(state.errors["connectors"], vm::refreshConnectors)
            }
            if (filtered.isEmpty() && "connectors" !in state.busy && state.errors["connectors"] == null) item {
                EmptyState(if (search.isBlank()) "No apps available yet" else "No matching apps", if (search.isBlank()) "The service directory is empty. Refresh to check again." else "Try another app name.")
            }
            items(filtered, key = { it.toolkit }) { connector ->
                PaperCard(Modifier.fillMaxWidth().testTag("connector.${connector.toolkit}")) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Icon(Icons.Outlined.Link, null, tint = Forest)
                        Column(Modifier.weight(1f)) {
                            Text(connector.name, style = MaterialTheme.typography.titleMedium)
                            Text(humanStatus(connector.status) + connector.email?.let { " · $it" }.orEmpty(), color = Muted, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    connector.description?.takeIf { it.isNotBlank() }?.let { Text(it, color = Muted, style = MaterialTheme.typography.bodySmall) }
                    if (connector.status == "connected") TextButton(onClick = { disconnect = connector }, enabled = "connectors" !in state.busy) { Text("Disconnect") }
                    else Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { vm.connect(connector.toolkit) { openWeb(context, it) } }, enabled = "connectors" !in state.busy) {
                            Text(if (connector.status == "expired") "Reconnect" else if (connector.status == "pending") "Continue connection" else "Connect")
                        }
                        if (connector.status == "pending") TextButton(onClick = vm::refreshConnectors) { Text("Check status") }
                    }
                    if (connector.status == "pending") Text("Finish authorization in your browser, then return here. Connection is confirmed by the service.", color = Muted, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        if (onContinue != null) Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Button(onClick = onContinue, enabled = "profile" !in state.busy,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("onboarding.finish")) {
                Text(if ("profile" in state.busy) "Saving…" else "Continue to Impo")
            }
            Text("You can change these connections later in Settings.", color = Muted, style = MaterialTheme.typography.bodySmall)
        }
    }
    consent?.let { kind ->
        val title = when (kind) { "calendar" -> "Connect Calendar?"; "contacts" -> "Connect Contacts?"; else -> "Connect Health?" }
        val detail = when (kind) {
            "calendar" -> "When your agent requests calendar context, Impo can read events on this device and send the requested event details to your Impo account. It cannot create, change or delete events."
            "contacts" -> "When you ask about someone, Impo can search contacts on this device and send matching names, companies, email addresses, phone numbers and birthdays to your Impo account. It does not upload your whole address book or change contacts."
            else -> "Choose which Health Connect data Impo may read. When your agent asks for it, Impo sends a summary of the requested steps, active calories, heart rate or sleep to your Impo account. Impo never writes Health data."
        }
        AlertDialog(onDismissRequest = { consent = null }, title = { Text(title) }, text = { Text(detail) },
            confirmButton = { TextButton(onClick = {
                consent = null
                when (kind) {
                    "calendar" -> calendarPermission.launch(Manifest.permission.READ_CALENDAR)
                    "contacts" -> contactsPermission.launch(Manifest.permission.READ_CONTACTS)
                    else -> if (healthAvailable) healthPermission.launch(vm.deviceAdapter.healthPermissions)
                }
            }) { Text("Choose read permissions") } }, dismissButton = { TextButton(onClick = { consent = null }) { Text("Not now") } })
    }
    disconnect?.let { connector -> AlertDialog(onDismissRequest = { disconnect = null }, title = { Text("Disconnect ${connector.name}?") },
        text = { Text("Your agent will no longer be able to use this connection. You can connect it again later.") },
        confirmButton = { TextButton(onClick = { disconnect = null; vm.disconnect(connector.toolkit) }) { Text("Disconnect") } },
        dismissButton = { TextButton(onClick = { disconnect = null }) { Text("Cancel") } }) }
}

@Composable fun BriefSettingsScreen(vm: AppViewModel, state: AppState, back: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val initial = state.briefSettings ?: vm.defaultBriefSettings()
    var name by rememberSaveable(initial) { mutableStateOf(initial.displayName) }
    var zone by rememberSaveable(initial) { mutableStateOf(initial.timeZone) }
    var locale by rememberSaveable(initial) { mutableStateOf(initial.locale) }
    var city by rememberSaveable(initial) { mutableStateOf(initial.location?.city.orEmpty()) }
    var country by rememberSaveable(initial) { mutableStateOf(initial.location?.country.orEmpty()) }
    var slots by rememberSaveable(initial, stateSaver = Saver<List<BriefSlot>, String>(
        save = { ProtocolJson.encodeToString(it) }, restore = { ProtocolJson.decodeFromString(it) })) { mutableStateOf(initial.slots) }
    var chosenLocation by remember(initial) { mutableStateOf(initial.location) }
    var locating by remember { mutableStateOf(false) }
    var validation by remember { mutableStateOf<String?>(null) }
    fun findCity() {
        locating = true; validation = null
        scope.launch {
            runCatching { BriefCityReader.read(context) }.onSuccess { value ->
                chosenLocation = value; city = value.city; country = value.country
            }.onFailure { validation = "Your city couldn't be found. Check location access or enter it manually." }
            locating = false
        }
    }
    val cityPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        if (grants[Manifest.permission.ACCESS_COARSE_LOCATION] == true || grants[Manifest.permission.ACCESS_FINE_LOCATION] == true) findCity()
        else validation = "Location wasn't allowed. You can still enter a city manually."
    }
    Column(Modifier.fillMaxSize()) {
        PageHeader("Brief preferences", "A little perspective, at your pace.", back)
        BusyLine("briefSettings" in state.busy)
        Column(Modifier.weight(1f).imePadding().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            PaperCard {
                Text("Your context", style = MaterialTheme.typography.titleLarge)
                OutlinedTextField(name, { name = it.take(100) }, label = { Text("Your name") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("briefSettings.name"))
                OutlinedTextField(locale, { locale = it.take(40) }, label = { Text("Brief language") }, supportingText = { Text("Language code, such as en-US or zh-CN") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("briefSettings.locale"))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { locale = "en-US" }) { Text("English") }
                    TextButton(onClick = { locale = "zh-CN" }) { Text("Chinese") }
                    TextButton(onClick = { locale = Locale.getDefault().toLanguageTag() }) { Text("Device") }
                }
                OutlinedTextField(zone, { zone = it.take(100) }, label = { Text("Time zone") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("briefSettings.zone"))
                TextButton(onClick = { zone = ZoneId.systemDefault().id }) { Text("Use device time zone") }
            }
            PaperCard {
                Text("Your Brief times", style = MaterialTheme.typography.titleLarge)
                Text("Briefs are prepared by the server at these local hours. Turning every time off pauses future editions.", color = Muted)
                slots.forEach { slot -> key(slot.id) {
                    BriefSlotEditor(slot, canRemove = slots.size > 1,
                        update = { edited -> slots = slots.map { if (it.id == edited.id) edited else it } },
                        remove = { slots = slots.filterNot { it.id == slot.id } })
                } }
                if (slots.size < 6) TextButton(onClick = {
                    val hour = (0..23).firstOrNull { candidate -> slots.none { it.enabled && it.hour == candidate } } ?: 9
                    slots = slots + BriefSlot("slot-${UUID.randomUUID().toString().take(8)}", "My Brief", hour, true)
                }) { Icon(Icons.Outlined.Add, null); Text("Add a Brief time") }
            }
            PaperCard {
                Text("Local context", style = MaterialTheme.typography.titleLarge)
                Text("An optional city helps your Brief with local context. A manual city stays until you change or clear it.", color = Muted)
                OutlinedTextField(city, { city = it.take(100) }, label = { Text("City") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("briefSettings.city"))
                OutlinedTextField(country, { country = it.take(100) }, label = { Text("Country") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("briefSettings.country"))
                OutlinedButton(onClick = { cityPermission.launch(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION)) }, enabled = !locating) {
                    Icon(Icons.Outlined.MyLocation, null); Spacer(Modifier.width(8.dp)); Text(if (locating) "Finding your city…" else "Use current city")
                }
                if (chosenLocation?.source == "device" && city == chosenLocation?.city && country == chosenLocation?.country)
                    Text("Device city captured ${shortDate(chosenLocation!!.capturedAt)}. It expires from Brief context after 24 hours.", color = Muted, style = MaterialTheme.typography.bodySmall)
                if (city.isNotBlank() || country.isNotBlank()) TextButton(onClick = { city = ""; country = "" }) { Text("Clear city") }
            }
            ErrorNotice(validation ?: state.errors["briefSettings"])
            Button(onClick = {
                validation = validateBriefSettings(zone, locale, slots, city, country)
                if (validation == null) {
                    val location = when {
                        city.isBlank() -> null
                        chosenLocation?.let { city.trim() == it.city && country.trim() == it.country } == true -> chosenLocation
                        else -> BriefLocation(city.trim(), country.trim(), wireTimestamp(Instant.now()), "manual")
                    }
                    vm.saveBriefSettings(BriefSettings(zone.trim(), locale.trim(), name.trim(), location, slots.map { it.copy(label = it.label.trim()) }), back)
                }
            }, enabled = "briefSettings" !in state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("briefSettings.save")) { Text("Save preferences") }
            Spacer(Modifier.height(20.dp))
        }
    }
}

internal fun validateBriefSettings(zone: String, locale: String, slots: List<BriefSlot>, city: String, country: String): String? = when {
    zone.trim() !in ZoneId.getAvailableZoneIds() && zone.trim() !in setOf("UTC", "GMT") -> "Choose a valid time zone, such as Asia/Shanghai."
    !locale.trim().matches(Regex("[A-Za-z0-9_-]{2,40}")) -> "Enter a valid language code, such as en-US or zh-CN."
    slots.size !in 1..6 -> "Choose between one and six Brief times."
    slots.any { !it.id.matches(Regex("[a-z][a-z0-9-]{0,39}")) } || slots.map { it.id }.distinct().size != slots.size -> "Every Brief time needs a unique identifier."
    slots.any { it.label.isBlank() || it.label.length > 60 || it.hour !in 0..23 } -> "Give every Brief a name and a valid hour."
    slots.filter { it.enabled }.map { it.hour }.let { it.distinct().size != it.size } -> "Enabled Brief times must use different hours."
    city.isNotBlank() && country.isBlank() -> "Add a country for your city."
    city.length > 100 || country.length > 100 -> "Keep the city and country names under 100 characters."
    else -> null
}

@Composable private fun BriefSlotEditor(slot: BriefSlot, canRemove: Boolean, update: (BriefSlot) -> Unit, remove: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Switch(checked = slot.enabled, onCheckedChange = { update(slot.copy(enabled = it)) })
            Text(if (slot.enabled) "Enabled" else "Paused", Modifier.weight(1f), color = Muted)
            if (canRemove) IconButton(onClick = remove) { Icon(Icons.Outlined.Close, "Remove ${slot.label}") }
        }
        OutlinedTextField(slot.label, { update(slot.copy(label = it.take(60))) }, label = { Text("Brief name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Box {
            OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Outlined.Schedule, null); Spacer(Modifier.width(8.dp)); Text("%02d:00".format(slot.hour)); Spacer(Modifier.weight(1f)); Icon(Icons.Outlined.ExpandMore, null)
            }
            DropdownMenu(expanded, onDismissRequest = { expanded = false }, modifier = Modifier.heightIn(max = 300.dp)) {
                (0..23).forEach { hour -> DropdownMenuItem(text = { Text("%02d:00".format(hour)) }, onClick = { update(slot.copy(hour = hour)); expanded = false }) }
            }
        }
        HorizontalDivider(color = Border, modifier = Modifier.padding(vertical = 8.dp))
    }
}

@Composable internal fun SettingsToggle(title: String, detail: String, checked: Boolean, tag: String, enabled: Boolean = true, change: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = Muted)
        }
        Switch(checked, onCheckedChange = change, enabled = enabled, modifier = Modifier.testTag(tag))
    }
}
@Composable private fun SettingsLink(title: String, detail: String?, icon: ImageVector, tag: String? = null, click: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 54.dp).then(if (tag != null) Modifier.testTag(tag) else Modifier).clickable(onClick = click),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(icon, null, tint = Forest)
        Column(Modifier.weight(1f).padding(vertical = 8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Muted) }
        }
        Icon(Icons.Outlined.ChevronRight, null, tint = Muted)
    }
}
@Composable private fun OnResume(action: () -> Unit) {
    val owner = LocalLifecycleOwner.current
    val latest by rememberUpdatedState(action)
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) latest() }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
}
private fun appSettings(context: Context) = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
private fun mail(subject: String, body: String) = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:cj@impo.ai"))
    .putExtra(Intent.EXTRA_SUBJECT, subject).putExtra(Intent.EXTRA_TEXT, body)
