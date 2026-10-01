package ai.impo.ui

import android.Manifest
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import ai.impo.nativebridge.*
import java.util.concurrent.CopyOnWriteArrayList
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Real gestures/lifecycle with an injected recorder. Server transcription is tested separately. */
@RunWith(AndroidJUnit4::class)
class VoiceComposerInstrumentedTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val clips = CopyOnWriteArrayList<RecordedVoiceClip>()
    private val typed = CopyOnWriteArrayList<String>()
    private val engines = CopyOnWriteArrayList<FakeRecorder>()
    private val text = mutableStateOf("")
    private val owner = mutableStateOf("session-a")
    private val busy = mutableStateOf(false)
    private val showSendControl = mutableStateOf(true)
    private var cancelledReplies = 0
    private class FakeRecorder(private val listener: (VoiceCaptureEvent) -> Unit) : VoiceRecorder {
        @Volatile var finishes = 0
        @Volatile var closes = 0
        override fun start() { listener(VoiceCaptureEvent.Ready); listener(VoiceCaptureEvent.Level(.7f)) }
        override fun finish(): VoiceRecording {
            finishes++
            return VoiceRecording(RecordedVoiceClip.fromBytes("fixture-native-clip".toByteArray()), 1_000)
        }
        override fun close() { closes++ }
        fun staleEvents() { listener(VoiceCaptureEvent.Level(1f)); listener(VoiceCaptureEvent.LimitReached) }
    }
    private val factory = VoiceRecorderFactory { listener -> FakeRecorder(listener).also(engines::add) }
    @Before fun showComposer() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.grantRuntimePermission(instrumentation.targetContext.packageName, Manifest.permission.RECORD_AUDIO)
        compose.setContent {
            val capturedOwner = owner.value
            ImpoTheme {
                Column(Modifier.fillMaxSize().safeDrawingPadding(), verticalArrangement = Arrangement.Bottom) {
                    VoiceComposer(text.value, { text.value = it }, busy.value, true, typed::add, { cancelledReplies++ }, "voiceTest", capturedOwner,
                        onVoiceClip = clips::add, isCurrent = { capturedOwner == owner.value },
                        showSendControl = showSendControl.value, recorderFactory = factory)
                }
            }
        }
    }
    private fun hold(fraction: Float = .5f, target: String = "voiceTest.composer") {
        val count = engines.size
        compose.onNodeWithTag(target).performTouchInput { down(Offset(center.x * 2 * fraction, center.y)) }
        compose.waitUntil(5_000) { engines.size == count + 1 }
        compose.onNodeWithTag("voiceTest.voice.preview").assertIsDisplayed()
    }
    private fun release() { compose.onNodeWithTag("voiceTest.composer").performTouchInput { up() } }

    @Test fun holdingLeftMiddleRightAndMicrophoneEmitsOneClipPerRelease() {
        listOf(.08f, .5f, .92f).forEachIndexed { index, fraction ->
            hold(fraction)
            assertEquals(index, clips.size)
            release()
            compose.waitUntil(5_000) { clips.size == index + 1 }
            engines.last().staleEvents(); compose.waitForIdle()
            assertEquals(index + 1, clips.size)
            assertEquals(1, engines.last().finishes); assertEquals(1, engines.last().closes)
        }
        hold(target = "voiceTest.voice"); release()
        compose.waitUntil(5_000) { clips.size == 4 }
        assertTrue(typed.isEmpty()); assertFalse(VoiceMicrophone.inUse.value)
    }

    @Test fun slideUpCancelsWithoutSendingOrKeepingDraftText() {
        hold()
        val cancelDrag = 120f * InstrumentationRegistry.getInstrumentation().targetContext.resources.displayMetrics.density
        compose.onNodeWithTag("voiceTest.composer").performTouchInput { moveBy(Offset(0f, -cancelDrag)) }
        compose.onNodeWithText("Release to cancel").assertIsDisplayed()
        release(); engines.last().staleEvents(); compose.waitForIdle()
        compose.onNodeWithTag("voiceTest.voice.preview").assertDoesNotExist()
        compose.onNodeWithTag("voiceTest.input").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
        assertTrue(clips.isEmpty()); assertTrue(typed.isEmpty()); assertFalse(VoiceMicrophone.inUse.value)
        assertEquals(0, engines.last().finishes); assertEquals(1, engines.last().closes)
    }

    @Test fun tapTypesAndNonemptyLongPressKeepsNormalDraft() {
        compose.onNodeWithTag("voiceTest.input").performTouchInput { click() }
        compose.onNodeWithTag("voiceTest.input").performTextInput("Keep this draft")
        compose.onNodeWithTag("voiceTest.input").performTouchInput { longClick() }
        compose.onNodeWithTag("voiceTest.input").assertTextEquals("Keep this draft")
        assertTrue(engines.isEmpty()); assertTrue(clips.isEmpty())
        compose.onNodeWithTag("voiceTest.send").performClick()
        assertEquals(listOf("Keep this draft"), typed.toList())
    }

    @Test fun replacingAccountScopeDiscardsTheHeldRecording() {
        hold(); val previous = engines.last()
        compose.runOnIdle { owner.value = "session-b" }
        compose.waitForIdle(); previous.staleEvents(); release(); compose.waitForIdle()
        assertTrue(clips.isEmpty()); assertFalse(VoiceMicrophone.inUse.value)
        assertEquals(0, previous.finishes); assertEquals(1, previous.closes)
        compose.onNodeWithTag("voiceTest.voice.preview").assertDoesNotExist()
    }

    @Test fun backgroundingCancelsCaptureWithoutCancellingAReply() {
        compose.runOnIdle { busy.value = true }
        hold(.3f); val previous = engines.last()
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        previous.staleEvents(); InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        assertTrue(clips.isEmpty()); assertEquals(1, previous.closes); assertFalse(VoiceMicrophone.inUse.value)
        assertEquals(0, cancelledReplies)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        release(); compose.onNodeWithTag("voiceTest.voice.preview").assertDoesNotExist()
    }

    @Test fun busyChatAllowsVoiceWhileItsReplyCancelButtonRetainsItsOwnTouchAction() {
        compose.runOnIdle { busy.value = true }
        compose.onNodeWithTag("voiceTest.cancel").performTouchInput { click() }
        compose.waitForIdle()
        assertEquals(1, cancelledReplies); assertTrue(engines.isEmpty())
        hold(.3f); release()
        compose.waitUntil(5_000) { clips.size == 1 }
        assertEquals(1, cancelledReplies); assertTrue(typed.isEmpty())
    }

    @Test fun taskComposerCanHideTextSendControlWhileKeepingVoiceAndImeSubmission() {
        compose.runOnIdle { showSendControl.value = false }
        compose.onNodeWithTag("voiceTest.send").assertDoesNotExist()
        hold(target = "voiceTest.voice"); release()
        compose.waitUntil(5_000) { clips.size == 1 }
        compose.onNodeWithTag("voiceTest.input").performTextInput("Create this task")
        compose.onNodeWithTag("voiceTest.send").assertDoesNotExist()
        compose.onNodeWithTag("voiceTest.input").performImeAction()
        assertEquals(listOf("Create this task"), typed.toList())
    }
}
