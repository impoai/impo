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
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.view.HapticFeedbackConstantsCompat
import androidx.core.view.ViewCompat
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
    onVoiceClip: (RecordedVoiceClip) -> Unit,
    isCurrent: () -> Boolean = { true },
    allowVoice: Boolean = true,
    voicePending: Boolean = false,
    voiceNotice: String? = null,
    inputTag: String = "$prefix.input",
    placeholder: String = "Tap to type · Hold to talk",
    maxLength: Int = 32768,
    showSendControl: Boolean = true,
    hasAttachments: Boolean = false,
    recorderFactory: VoiceRecorderFactory? = null,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val keyboard = LocalSoftwareKeyboardController.current
    val focusManager = LocalFocusManager.current
    val focus = remember { FocusRequester() }
    val latestCurrent by rememberUpdatedState(isCurrent)
    val latestValue by rememberUpdatedState(value)
    val latestCanRecord by rememberUpdatedState(allowVoice && !voicePending)
    val latestClip by rememberUpdatedState(onVoiceClip)
    val latestBusy by rememberUpdatedState(busy)
    val latestHapticView by rememberUpdatedState(LocalView.current)
    val factory = recorderFactory ?: remember(context) { AndroidVoiceRecorderFactory(context.applicationContext) }
    val controller = remember(sessionKey, factory) {
        VoiceInputController(scope, factory, startBlocked = {
            when {
                !latestCurrent() -> "This conversation changed. Hold again to talk."
                !latestCanRecord || latestValue.isNotEmpty() -> "Voice input is no longer available for this draft."
                !lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) -> "Open Impo to use voice input."
                ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED -> "Allow Microphone access in Android settings to talk to Impo."
                NativeBridge.recording.value.isRecording -> "Pause Echo before using voice input."
                else -> null
            }
        }, onClip = { clip ->
            if (latestCurrent() && latestCanRecord && latestValue.isEmpty()) latestClip(clip)
        }, onCancelBoundaryChanged = { armed ->
            // Native compatibility mapping preserves the user's system haptic setting.
            ViewCompat.performHapticFeedback(latestHapticView, if (armed)
                HapticFeedbackConstantsCompat.GESTURE_THRESHOLD_ACTIVATE else
                HapticFeedbackConstantsCompat.GESTURE_THRESHOLD_DEACTIVATE)
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
    LaunchedEffect(echo.isRecording, value, allowVoice, voicePending) {
        if (voice.active && (echo.isRecording || value.isNotEmpty() || !allowVoice || voicePending))
            controller.cancel(if (echo.isRecording) "Pause Echo before using voice input." else null)
    }
    BackHandler(voice.active) { controller.cancel() }
    fun begin() {
        if (!latestCurrent() || !latestCanRecord || latestValue.isNotEmpty()) return
        focusManager.clearFocus(); keyboard?.hide()
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            if (permissionHold == null) {
                permissionHold = controller to controller.permissionRequested()
                permission.launch(Manifest.permission.RECORD_AUDIO)
            }
        } else controller.begin()
    }
    fun submit() {
        if ((value.isNotBlank() || hasAttachments) && value.length <= maxLength && !busy && allowSend && isCurrent()) { onSend(value.trim()); onValueChange("") }
    }
    val holdEnabled = value.isEmpty() && !hasAttachments && allowVoice && !voicePending
    val beginCurrent by rememberUpdatedState { begin() }
    val tapCurrent by rememberUpdatedState { focus.requestFocus(); keyboard?.show() }
    var coordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
    var cancelVoiceBounds by remember { mutableStateOf<Rect?>(null) }
    var cancelReplyBounds by remember { mutableStateOf<Rect?>(null) }
    val latestVoiceActive by rememberUpdatedState(voice.active)
    val cancelDistance = with(LocalDensity.current) { 65.dp.toPx() }
    val movementSlop = with(LocalDensity.current) { 12.dp.toPx() }
    val hold = if (!holdEnabled) Modifier else Modifier.pointerInput(controller, cancelDistance, movementSlop) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val start = coordinates?.takeIf { it.isAttached }?.localToWindow(down.position) ?: down.position
            // A running reply remains independently cancellable, including during a voice hold.
            if ((latestBusy && cancelReplyBounds?.contains(start) == true) ||
                (latestVoiceActive && cancelVoiceBounds?.contains(start) == true)) return@awaitEachGesture
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
        ErrorNotice(voice.message ?: voiceNotice)
        if (voicePending) Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp).testTag("$prefix.voice.transcribing"),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp); Text("Transcribing…")
        }
        if (voice.active) Surface(color = if (voice.cancelArmed) MaterialTheme.colorScheme.errorContainer else Sage,
            shape = RoundedCornerShape(24.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp).testTag("$prefix.voice.preview")) {
            Column(Modifier.padding(18.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (voice.phase == VoicePhase.Finishing) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp); Text("Finishing recording…")
                    }
                    TextButton(onClick = { controller.cancel() }) { Text("Cancel voice input") }
                } else {
                    Text(if (voice.cancelArmed) "Release to cancel" else if (voice.limitReached) "Recording limit reached · Release to send" else if (voice.phase == VoicePhase.Starting) "Starting microphone…" else "Release to send · Slide up to cancel")
                    Row(Modifier.widthIn(max = 237.dp).fillMaxWidth().height(34.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                        voice.levels.forEach { level -> Box(Modifier.weight(1f).height((4 + 30 * level).dp).clip(RoundedCornerShape(2.dp)).background(if (voice.cancelArmed) MaterialTheme.colorScheme.error else Forest)) }
                    }
                    Text("Up to 2 minutes · Sent to Impo and Google Gemini after release", style = MaterialTheme.typography.labelSmall, color = Muted)
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
            OutlinedTextField(value, {
                if (it.length <= maxLength || it.length < value.length) onValueChange(it)
                else if (value.length <= maxLength) onValueChange(it.take(maxLength))
            }, readOnly = voice.active,
                placeholder = { Text(placeholder) }, modifier = Modifier.weight(1f).focusRequester(focus).testTag(inputTag), maxLines = 6,
                shape = RoundedCornerShape(26.dp), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send), keyboardActions = KeyboardActions(onSend = { submit() }))
            if (holdEnabled && !voice.active) Surface(Modifier.size(52.dp).testTag("$prefix.voice"), shape = RoundedCornerShape(26.dp), color = Sage) {
                Box(contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Mic, "Hold the empty input to talk") }
            } else if (voice.active) FilledIconButton(onClick = { controller.cancel() },
                modifier = Modifier.size(52.dp).onGloballyPositioned { cancelVoiceBounds = it.boundsInWindow() }.testTag("$prefix.voice.cancel")) {
                Icon(Icons.Outlined.Close, "Cancel voice input")
            } else if (!busy && showSendControl) FilledIconButton(onClick = { submit() }, enabled = (value.isNotBlank() || hasAttachments) && value.length <= maxLength && allowSend,
                modifier = Modifier.size(52.dp).testTag("$prefix.send")) {
                Icon(Icons.AutoMirrored.Outlined.Send, "Send message")
            }
            if (busy) FilledIconButton(onClick = onCancel,
                modifier = Modifier.size(52.dp).onGloballyPositioned { cancelReplyBounds = it.boundsInWindow() }.testTag("$prefix.cancel")) {
                Icon(Icons.Outlined.Stop, "Cancel reply")
            }
        }
    }
}
