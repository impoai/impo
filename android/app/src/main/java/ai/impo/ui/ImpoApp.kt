package ai.impo.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.*
import ai.impo.BuildConfig
import ai.impo.data.*
import ai.impo.nativebridge.NativeBridge
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

fun openWeb(context: Context, raw: String) {
    val uri = Uri.parse(raw)
    require(uri.scheme in setOf("https", "http")) { "Unsupported link" }
    CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, uri)
}
@Composable fun ImpoApp(vm: AppViewModel) {
    val auth by vm.auth.state.collectAsStateWithLifecycle()
    val state by vm.state.collectAsStateWithLifecycle()
    AccountDeletionStatusDialog(vm)
    Surface(Modifier.fillMaxSize(), color = Paper) {
        when {
            auth.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            auth.account == null -> WelcomeScreen(vm)
            state.account?.requestScope != auth.account?.requestScope -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            !state.profileLoaded -> Column(Modifier.fillMaxSize().safeDrawingPadding().padding(28.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                if (state.errors["profile"] == null || "profile" in state.busy) CircularProgressIndicator()
                Text("Restoring your account", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(vertical = 20.dp))
                ErrorNotice(state.errors["profile"], if ("profile" !in state.busy) vm::retryProfile else null)
                if (state.errors["profile"] != null) TextButton(onClick = vm::signOut) { Text("Sign out") }
            }
            !state.profile.onboarded && state.account?.development != true -> key(state.account?.requestScope) { OnboardingScreen(vm, state) }
            else -> key(state.account?.requestScope) { SignedInApp(vm, state) }
        }
    }
}
@Composable private fun WelcomeScreen(vm: AppViewModel) {
    val auth by vm.auth.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var connecting by remember { mutableStateOf<SignInProvider?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var development by rememberSaveable { mutableStateOf(false) }
    var endpoint by rememberSaveable { mutableStateOf("http://10.0.2.2:3011") }
    fun signIn(provider: SignInProvider) {
        connecting = provider
        error = null
        scope.launch {
            try { vm.auth.signIn(provider) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { error = failure.message }
            finally { connecting = null }
        }
    }
    Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(28.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Spacer(Modifier.height(32.dp))
        AssistantAvatar(3, 80)
        Text("Meet Impo,", style = MaterialTheme.typography.headlineLarge)
        Text("an open assistant that captures everything around your life.", color = Muted, style = MaterialTheme.typography.bodyLarge)
        PaperCard {
            Text("Capture everything with Echo.", style = MaterialTheme.typography.titleLarge)
            Text("Keep the spoken moments you choose to record. Talk things through, delegate tasks and find your daily perspective in Brief.", color = Muted)
            Text("Fully open source.", color = Forest, style = MaterialTheme.typography.labelLarge)
        }
        ErrorNotice(error ?: auth.error)
        Button(onClick = { signIn(SignInProvider.Google) }, enabled = connecting == null,
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("auth.google")) {
            Text(if (connecting == SignInProvider.Google) "Opening Google…" else "Continue with Google")
        }
        OutlinedButton(onClick = { signIn(SignInProvider.Apple) }, enabled = connecting == null,
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("auth.apple")) {
            Text(if (connecting == SignInProvider.Apple) "Opening Apple…" else "Continue with Apple")
        }
        Text("Your memories, conversations and recordings stay connected to your account.", color = Muted, style = MaterialTheme.typography.bodySmall)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TextButton(onClick = { openWeb(context, "https://impo.ai/privacy/") }) { Text("Privacy") }
            TextButton(onClick = { openWeb(context, "https://impo.ai/terms/") }) { Text("Terms") }
        }
        if (BuildConfig.DEBUG) {
            TextButton(onClick = { development = !development }) { Text("Developer connection") }
            if (development) {
                OutlinedTextField(endpoint, { endpoint = it }, label = { Text("Local API URL") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("auth.endpoint"))
                Text("Connects to an explicitly configured local development server.", color = Muted, style = MaterialTheme.typography.bodySmall)
                OutlinedButton(onClick = { scope.launch { runCatching { vm.auth.connectDevelopment(endpoint) }.onFailure { error = it.message } } }, modifier = Modifier.testTag("auth.development")) { Text("Connect local server") }
            }
        }
    }
}
@Composable private fun OnboardingScreen(vm: AppViewModel, state: AppState) {
    var consent by rememberSaveable { mutableStateOf(false) }
    var connections by rememberSaveable { mutableStateOf(false) }
    val context = LocalContext.current
    if (!consent) Column(Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Text("AI Data Processing Notice", style = MaterialTheme.typography.headlineLarge)
        Text("Your messages and selected connected data go to Impo, Rebyte, and its AI model providers, including OpenAI, to answer requests. Google Gemini processes voice audio and creates memory search embeddings.")
        Text("Saved messages, confirmed personal Echo speech and tasks may also be processed in background Brief and memory jobs. Every data connection is optional. Share only information you want processed.")
        TextButton(onClick = { openWeb(context, "https://impo.ai/privacy/") }) { Text("Read the Privacy Policy") }
        Button(onClick = { consent = true }, modifier = Modifier.fillMaxWidth()) { Text("I Agree") }
        TextButton(onClick = vm::signOut) { Text("Cancel") }
    } else if (connections) {
        ConnectionsScreen(vm, state, back = { connections = false }, onContinue = {
            vm.saveProfile(vm.state.value.profile.copy(onboarded = true))
        })
    } else PersonalizeScreen(state.profile, saving = "profile" in state.busy, error = state.errors["profile"]) {
        vm.saveProfile(it, onSaved = { connections = true })
    }
}
@Composable fun PersonalizeScreen(profile: UserSettings, saving: Boolean = false, error: String? = null,
    buttonLabel: String = "Continue", save: (UserSettings) -> Unit) {
    var name by rememberSaveable { mutableStateOf(profile.displayName) }
    var assistant by rememberSaveable { mutableStateOf(profile.assistantName) }
    var avatar by rememberSaveable { mutableIntStateOf(profile.avatar) }
    Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
        Spacer(Modifier.height(16.dp))
        AssistantAvatar(avatar, 96)
        Text("Make yourself at home.", style = MaterialTheme.typography.headlineLarge)
        OutlinedTextField(name, { name = it.take(100) }, label = { Text("Your name") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("onboarding.name"))
        OutlinedTextField(assistant, { assistant = it.take(30) }, label = { Text("Your assistant's name") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("onboarding.assistant"))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { avatarChoices.forEach { index ->
            Surface(Modifier.testTag("onboarding.avatar.$index").semantics { contentDescription = "${avatarNames[index]} avatar"; selected = avatar == index }
                .clickable { avatar = index }, shape = MaterialTheme.shapes.medium, color = if (avatar == index) Sage else Paper) { AssistantAvatar(index, 48) }
        } }
        Text("You can connect Calendar, Health, Contacts and other apps whenever you're ready.", color = Muted)
        ErrorNotice(error)
        Button(onClick = { save(profile.copy(displayName = name.trim(), assistantName = assistant.trim().ifEmpty { "Momo" }, avatar = avatar)) }, enabled = !saving,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("onboarding.continue")) { Text(if (saving) "Saving…" else buttonLabel) }
    }
}
private data class MainTab(val route: String, val label: String, val icon: androidx.compose.ui.graphics.vector.ImageVector)
private val tabs = listOf(MainTab("chat", "Chat", Icons.Outlined.ChatBubbleOutline), MainTab("brief", "Brief", Icons.Outlined.WbSunny), MainTab("tasks", "Tasks", Icons.Outlined.CheckCircleOutline), MainTab("memories", "Memories", Icons.Outlined.AutoStories))
@Composable private fun SignedInApp(vm: AppViewModel, state: AppState) {
    val nav = rememberNavController()
    val backStack by nav.currentBackStackEntryAsState()
    val route = backStack?.destination?.route ?: "chat"
    val recording by NativeBridge.recording.collectAsStateWithLifecycle()
    val go: (String) -> Unit = { target -> nav.navigate(target) { launchSingleTop = true } }
    var echoReminderEvent by remember { mutableStateOf<String?>(null) }
    val pushRoute by vm.app.push.route.collectAsStateWithLifecycle()
    LaunchedEffect(pushRoute) {
        pushRoute?.let { route ->
            when (route.category) {
                "chat" -> go("chat")
                "tasks", "scheduledTasks" -> go("task/${route.targetId}")
                "brief" -> { vm.openNotificationBrief(route.targetId); go("brief") }
                "echo" -> { echoReminderEvent = route.eventId; go("memories") }
            }
            vm.app.push.consumeRoute()
        }
    }
    val back: () -> Unit = { nav.popBackStack() }
    Scaffold(containerColor = Paper, contentWindowInsets = WindowInsets.safeDrawing,
        bottomBar = { if (tabs.any { it.route == route }) NavigationBar(containerColor = RaisedPaper, tonalElevation = 0.dp) {
            tabs.forEach { tab -> NavigationBarItem(selected = route == tab.route, onClick = { nav.navigate(tab.route) { popUpTo("chat") { saveState = true }; launchSingleTop = true; restoreState = true } },
                icon = { Icon(tab.icon, null) }, label = { Text(tab.label) }, modifier = Modifier.testTag("nav.${tab.route}"), colors = NavigationBarItemDefaults.colors(indicatorColor = Sage, selectedTextColor = Forest, selectedIconColor = Forest, unselectedTextColor = Muted, unselectedIconColor = Muted)) }
        } }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            ErrorNotice(state.errors["profile"], if ("profile" !in state.busy) vm::retryProfile else null)
            if (recording.isRecording || recording.isPaused) Surface(color = Sage, modifier = Modifier.fillMaxWidth().clickable { go("memories") }) {
                Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.GraphicEq, null)
                    Text(if (recording.isRecording) "Echo is listening" else "Echo is paused", Modifier.weight(1f).padding(start = 10.dp))
                    IconButton(onClick = { if (recording.isRecording) NativeBridge.pauseEcho(vm.app) else NativeBridge.resumeEcho(vm.app) }) { Icon(if (recording.isRecording) Icons.Outlined.Pause else Icons.Outlined.PlayArrow, if (recording.isRecording) "Pause Echo" else "Resume Echo") }
                    IconButton(onClick = { NativeBridge.stopEcho(vm.app) }, modifier = Modifier.testTag("echo.stop")) { Icon(Icons.Outlined.Stop, "Stop Echo") }
                }
            }
            NavHost(nav, "chat", Modifier.weight(1f)) {
                composable("chat") { ChatScreen(vm, state, go) }
                composable("brief") { BriefScreen(vm, state, go) }
                composable("scheduled-tasks") { ScheduledTasksScreen(vm, state, go, back) }
                composable("schedule/{id}") { entry -> ScheduledTaskEditor(vm, state, entry.arguments?.getString("id")!!, go, back) }
                composable("tasks") { TasksScreen(vm, state, go) }
                composable("memories") { MemoriesScreen(vm, state, go, echoReminderEvent) }
                composable("settings") { SettingsScreen(vm, state, go, back) }
                composable("assistant") { Column { PageHeader("Your assistant", back = back); PersonalizeScreen(state.profile, saving = "profile" in state.busy, buttonLabel = "Save changes") { vm.saveProfile(it, onSaved = back) } } }
                composable("connections") { ConnectionsScreen(vm, state, back) }
                composable("echo-schedule") { EchoScheduleScreen(vm, back) }
                composable("brief-settings") { BriefSettingsScreen(vm, state, back) }
                composable("task/{id}") { entry -> val id = entry.arguments?.getString("id")!!; LaunchedEffect(id) { vm.openTask(id) }; TaskConversationScreen(vm, state, back) }
                composable("echo/{id}") { entry -> val id = entry.arguments?.getString("id")!!; LaunchedEffect(id) { vm.openRecord(id) }; EchoDetailScreen(vm, state, id, back) }
                composable("source/{brief}/{record}") { entry -> val brief = entry.arguments?.getString("brief")!!; val record = entry.arguments?.getString("record")!!; LaunchedEffect(brief, record) { vm.loadSource(brief, record) }; SourceScreen(vm, state, back) }
            }
        }
    }
}
@Composable fun RecordButton(vm: AppViewModel, profile: UserSettings) {
    val context = LocalContext.current
    val recording by NativeBridge.recording.collectAsStateWithLifecycle()
    var explain by remember { mutableStateOf(false) }
    var denied by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        if (grants[Manifest.permission.RECORD_AUDIO] == true) { denied = false; NativeBridge.startEcho(context, profile.recordingLocation) } else denied = true
    }
    if (!recording.isRecording && !recording.isPaused) OutlinedButton(onClick = { explain = true }, modifier = Modifier.testTag("echo.start")) { Icon(Icons.Outlined.Mic, null); Spacer(Modifier.width(6.dp)); Text("Record Echo") }
    ErrorNotice(if (denied) "Microphone permission is needed to record. You can enable it in Android settings." else recording.message)
    if (explain) AlertDialog(onDismissRequest = { explain = false }, title = { Text("Capture a thought") }, text = { Text("Echo listens while you choose to record. Speech is saved on this device, uploaded securely and transcribed into Echo. Confirm your voice before using speech in memories or Brief. A recording notification stays visible, and you can pause or stop at any time.") }, confirmButton = { TextButton(onClick = {
        explain = false
        permission.launch(buildList { add(Manifest.permission.RECORD_AUDIO); if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS) }.toTypedArray())
    }) { Text("Start recording") } }, dismissButton = { TextButton(onClick = { explain = false }) { Text("Not now") } })
}
