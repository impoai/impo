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

/** Real Compose gestures/lifecycle, with an injected recognizer. No synthetic production speech path. */
@RunWith(AndroidJUnit4::class)
class VoiceComposerInstrumentedTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val sent = CopyOnWriteArrayList<String>()
    private val engines = CopyOnWriteArrayList<FakeRecognizer>()
    private val text = mutableStateOf("")
    private val owner = mutableStateOf("session-a")
    private class FakeRecognizer(private val listener: (VoiceRecognitionEvent) -> Unit) : VoiceRecognizer {
        override val onDevice = true
        @Volatile var finishes = 0
        @Volatile var closes = 0
        override fun start() { listener(VoiceRecognitionEvent.Ready); listener(VoiceRecognitionEvent.Partial("Voice gesture")) }
        override fun finish() { finishes++ }
        override fun close() { closes++ }
        fun final(text: String) = listener(VoiceRecognitionEvent.Final(text))
    }
    private val factory = VoiceRecognizerFactory { listener -> FakeRecognizer(listener).also(engines::add) }
    @Before fun showComposer() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.grantRuntimePermission(instrumentation.targetContext.packageName, Manifest.permission.RECORD_AUDIO)
        compose.setContent {
            val capturedOwner = owner.value
            ImpoTheme {
                Column(Modifier.fillMaxSize().safeDrawingPadding(), verticalArrangement = Arrangement.Bottom) {
                    VoiceComposer(text.value, { text.value = it }, false, true, sent::add, {}, "voiceTest", capturedOwner,
                        isCurrent = { capturedOwner == owner.value }, recognizerFactory = factory)
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

    @Test fun holdingLeftMiddleRightAndMicrophoneSendsOncePerRelease() {
        listOf(.08f, .5f, .92f).forEachIndexed { index, fraction ->
            hold(fraction)
            assertEquals(index, sent.size)
            release()
            compose.onNodeWithTag("voiceTest.voice.transcribing").assertIsDisplayed()
            engines.last().final("Message $index")
            compose.waitUntil(5_000) { sent.size == index + 1 }
            engines.last().final("Duplicate")
            compose.waitForIdle()
            assertEquals(index + 1, sent.size)
        }
        hold(target = "voiceTest.voice")
        release(); engines.last().final("From microphone")
        compose.waitUntil(5_000) { sent.size == 4 }
    }

    @Test fun slideUpCancelsWithoutSendingOrKeepingPartialText() {
        hold()
        // Touch injection uses pixels; the production cancellation boundary is 65 dp.
        val cancelDrag = 120f * InstrumentationRegistry.getInstrumentation().targetContext.resources.displayMetrics.density
        compose.onNodeWithTag("voiceTest.composer").performTouchInput { moveBy(Offset(0f, -cancelDrag)) }
        compose.onNodeWithText("Release to cancel").assertIsDisplayed()
        release(); engines.last().final("Cancelled")
        compose.waitForIdle()
        compose.onNodeWithTag("voiceTest.voice.preview").assertDoesNotExist()
        compose.onNodeWithTag("voiceTest.input").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
        assertTrue(sent.isEmpty()); assertFalse(VoiceMicrophone.inUse.value)
    }

    @Test fun tapTypesAndNonemptyLongPressKeepsNormalDraft() {
        compose.onNodeWithTag("voiceTest.input").performTouchInput { click() }
        compose.onNodeWithTag("voiceTest.input").performTextInput("Keep this draft")
        compose.onNodeWithTag("voiceTest.input").performTouchInput { longClick() }
        compose.onNodeWithTag("voiceTest.input").assertTextEquals("Keep this draft")
        assertTrue(engines.isEmpty()); assertTrue(sent.isEmpty())
        compose.onNodeWithTag("voiceTest.send").performClick()
        assertEquals(listOf("Keep this draft"), sent.toList())
    }

    @Test fun replacingAccountScopeDropsFinishingCallbacks() {
        hold(); release()
        val previous = engines.last()
        compose.runOnIdle { owner.value = "session-b" }
        compose.waitForIdle(); previous.final("Old account transcript")
        compose.waitForIdle()
        assertTrue(sent.isEmpty()); assertFalse(VoiceMicrophone.inUse.value)
        compose.onNodeWithTag("voiceTest.voice.preview").assertDoesNotExist()
    }

    @Test fun backgroundingCancelsFinalizationAndDestroysRecognizer() {
        hold(); release()
        val previous = engines.last()
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        previous.final("Late background transcript")
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        assertTrue(sent.isEmpty()); assertEquals(1, previous.closes); assertFalse(VoiceMicrophone.inUse.value)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        compose.onNodeWithTag("voiceTest.voice.preview").assertDoesNotExist()
    }
}
