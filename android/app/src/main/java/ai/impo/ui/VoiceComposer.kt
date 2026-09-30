package ai.impo.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.impo.nativebridge.*

/** A tap types; a hold anywhere in the empty row talks. Nonempty fields keep Android selection. */
@Composable fun VoiceComposer(
    value: String,
    onValueChange: (String) -> Unit,
    busy: Boolean,
    allowSend: Boolean,
    onSend: (String) -> Unit,
    onCancel: () -> Unit,
    prefix: String,
    sessionKey: Any?,
    isCurrent: () -> Boolean = { true },
    recognizerFactory: VoiceRecognizerFactory? = null,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val keyboard = LocalSoftwareKeyboardController.current
    val focusManager = LocalFocusManager.current
    val focus = remember { FocusRequester() }
    val latestCurrent by rememberUpdatedState(isCurrent)
    val latestValue by rememberUpdatedState(value)
    val latestCanSend by rememberUpdatedState(!busy && allowSend)
    val latestChanged by rememberUpdatedState(onValueChange)
    val latestSend by rememberUpdatedState(onSend)
    val factory = recognizerFactory ?: remember(context) { AndroidVoiceRecognizerFactory(context.applicationContext) }
    val controller = remember(sessionKey, factory) {
        VoiceInputController(scope, factory, startBlocked = {
            when {
                !latestCurrent() -> "This conversation changed. Hold again to talk."
                !lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) -> "Open Impo to use voice input."
                ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED -> "Allow Microphone access in Android settings to talk to Impo."
                NativeBridge.recording.value.isRecording -> "Pause Echo before using voice input."
                else -> null
            }
        }, onTranscript = { text ->
            if (latestCurrent() && latestValue.isEmpty()) {
                if (latestCanSend) latestSend(text) else latestChanged(text)
            }
        })
    }
    val voice by controller.state.collectAsStateWithLifecycle()
    val echo by NativeBridge.recording.collectAsStateWithLifecycle()
    var permissionHold by remember(controller) { mutableStateOf<Pair<VoiceInputController, Long>?>(null) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permissionHold?.let { (owner, ticket) -> owner.permissionResult(ticket, granted) }
        permissionHold = null
    }
    DisposableEffect(controller, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) controller.cancel() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); controller.close() }
    }
    LaunchedEffect(echo.isRecording, value, busy, allowSend) {
        if (voice.active && (echo.isRecording || value.isNotEmpty() || busy || !allowSend))
            controller.cancel(if (echo.isRecording) "Pause Echo before using voice input." else null)
    }
    BackHandler(voice.active) { controller.cancel() }
    fun begin() {
        if (!latestCurrent() || !latestCanSend || latestValue.isNotEmpty()) return
        focusManager.clearFocus(); keyboard?.hide()
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            if (permissionHold == null) {
                permissionHold = controller to controller.permissionRequested()
                permission.launch(Manifest.permission.RECORD_AUDIO)
            }
        } else controller.begin()
    }
    fun submit() {
        if (value.isNotBlank() && !busy && allowSend && isCurrent()) { onSend(value.trim()); onValueChange("") }
    }
    val holdEnabled = value.isEmpty() && !busy && allowSend
    val beginCurrent by rememberUpdatedState { begin() }
    val tapCurrent by rememberUpdatedState { focus.requestFocus(); keyboard?.show() }
    var coordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
    val cancelDistance = with(LocalDensity.current) { 65.dp.toPx() }
    val movementSlop = with(LocalDensity.current) { 12.dp.toPx() }
    val hold = if (!holdEnabled) Modifier else Modifier.pointerInput(controller, cancelDistance, movementSlop) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val start = coordinates?.takeIf { it.isAttached }?.localToWindow(down.position) ?: down.position
            down.consume()
            var position = start
            var released = false
            var movedBeforeHold = false
            var cancelled = false
            try {
                val quick = withTimeoutOrNull(350L) {
                    while (true) {
                        val event = awaitPointerEvent(PointerEventPass.Initial)
                        val change = event.changes.firstOrNull { it.id == down.id }
                        if (change == null || event.changes.count { it.pressed } > 1) { cancelled = true; return@withTimeoutOrNull true }
                        position = coordinates?.takeIf { it.isAttached }?.localToWindow(change.position) ?: change.position
                        if ((position - start).getDistance() > movementSlop) movedBeforeHold = true
                        change.consume()
                        if (!change.pressed) { released = true; return@withTimeoutOrNull true }
                        if (movedBeforeHold) return@withTimeoutOrNull true
                    }
                    @Suppress("UNREACHABLE_CODE") false
                }
                if (quick == true) {
                    if (released && !movedBeforeHold && !cancelled) tapCurrent()
                } else {
                    beginCurrent()
                    while (true) {
                        val event = awaitPointerEvent(PointerEventPass.Initial)
                        val change = event.changes.firstOrNull { it.id == down.id }
                        if (change == null || event.changes.count { it.pressed } > 1) { controller.cancel(); break }
                        position = coordinates?.takeIf { it.isAttached }?.localToWindow(change.position) ?: change.position
                        controller.move(position.y - start.y < -cancelDistance)
                        change.consume()
                        if (!change.pressed) { controller.finish(); released = true; break }
                    }
                }
            } finally {
                if (!released) controller.cancel()
            }
        }
    }
    Column(Modifier.fillMaxWidth().imePadding()) {
        ErrorNotice(voice.message)
        if (voice.active) Surface(color = if (voice.cancelArmed) MaterialTheme.colorScheme.errorContainer else Sage,
            shape = RoundedCornerShape(24.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp).testTag("$prefix.voice.preview")) {
            Column(Modifier.padding(18.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (voice.transcript.isNotBlank() && !voice.cancelArmed) Text(voice.transcript, maxLines = 4, modifier = Modifier.testTag("$prefix.voice.transcript"))
                if (voice.phase == VoicePhase.Finishing) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.testTag("$prefix.voice.transcribing")) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp); Text("Transcribing…")
                    }
                    TextButton(onClick = { controller.cancel() }) { Text("Cancel voice input") }
                } else {
                    Text(if (voice.cancelArmed) "Release to cancel" else if (voice.phase == VoicePhase.Starting) "Starting microphone…" else "Release to send · Slide up to cancel")
                    Row(Modifier.height(34.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                        voice.levels.forEach { level -> Box(Modifier.width(3.dp).height((4 + 30 * level).dp).clip(RoundedCornerShape(2.dp)).background(if (voice.cancelArmed) MaterialTheme.colorScheme.error else Forest)) }
                    }
                    Text(if (voice.onDevice) "On-device speech recognition" else "Your Android speech service may process audio online.", style = MaterialTheme.typography.labelSmall, color = Muted)
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp).onGloballyPositioned { coordinates = it }
            .then(hold).testTag("$prefix.composer").semantics {
                customActions = if (voice.active) listOf(
                    CustomAccessibilityAction("Send voice input") { controller.finish(); true },
                    CustomAccessibilityAction("Cancel voice input") { controller.cancel(); true },
                ) else if (holdEnabled) listOf(CustomAccessibilityAction("Start voice input") { begin(); true }) else emptyList()
            }, verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(value, { onValueChange(it.take(32768)) }, readOnly = voice.active,
                placeholder = { Text("Tap to type · Hold to talk") }, modifier = Modifier.weight(1f).focusRequester(focus).testTag("$prefix.input"), maxLines = 6,
                shape = RoundedCornerShape(26.dp), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send), keyboardActions = KeyboardActions(onSend = { submit() }))
            if (holdEnabled && !voice.active) Surface(Modifier.size(52.dp).testTag("$prefix.voice"), shape = RoundedCornerShape(26.dp), color = Sage) {
                Box(contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Mic, "Hold the empty input to talk") }
            } else FilledIconButton(onClick = { if (voice.active) controller.cancel() else if (busy) onCancel() else submit() },
                enabled = voice.active || busy || (value.isNotBlank() && allowSend), modifier = Modifier.size(52.dp).testTag(if (busy) "$prefix.cancel" else "$prefix.send")) {
                Icon(if (voice.active) Icons.Outlined.Close else if (busy) Icons.Outlined.Stop else Icons.AutoMirrored.Outlined.Send,
                    if (voice.active) "Cancel voice input" else if (busy) "Cancel reply" else "Send message")
            }
        }
    }
}
