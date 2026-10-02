package ai.impo.ui

import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import ai.impo.MainActivity
import java.io.File
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class) class EchoSpeakersInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()
    private fun waitTag(tag: String) { compose.waitUntil(20_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() } }
    private fun waitText(text: String) { compose.waitUntil(10_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() } }
    private fun screenshot(name: String) {
        val directory = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir") ?: return
        val target = File(directory).apply { mkdirs() }
        compose.waitForIdle()
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        device.waitForIdle()
        device.takeScreenshot(File(target, name))
    }
    @Test fun chooseExcludeRestoreAndRevokeYourVoice() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("impo.test.api", "http://127.0.0.1:3011")).use { scenario ->
            waitTag("nav.memories"); compose.onNodeWithTag("nav.memories").performClick()
            waitTag("memories.echo"); compose.onNodeWithTag("memories.echo").performClick()
            compose.waitUntil(20_000) { compose.onAllNodes(hasTestTag("echo.list")).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("echo.list").performScrollToIndex(1)
            waitText("Morning walk"); compose.onNodeWithText("Morning walk").performClick()
            waitTag("echo.speakers.edit"); compose.onNodeWithTag("echo.speakers.edit").performClick()
            waitTag("echo.speakers.option.0")
            screenshot("echo-speaker-choices.png")
            compose.onNodeWithTag("echo.speakers.option.0").performClick()
            compose.onNodeWithTag("echo.speakers.save").performClick()
            waitText("Your voice is selected")
            compose.onNodeWithTag("echo.speakers.u1.toggle").performScrollTo().performClick()
            waitText("Excluded from memories and Brief")
            screenshot("echo-speaker-confirmed.png")
            scenario.recreate()
            waitText("Your voice is selected"); waitText("Excluded from memories and Brief")
            compose.onNodeWithTag("echo.speakers.edit").performScrollTo().performClick()
            compose.onNodeWithTag("echo.speakers.unknown").performScrollTo().performClick()
            compose.onNodeWithTag("echo.speakers.save").performClick()
            waitText("Which voice is yours?")
            compose.onNodeWithTag("echo.speakers.u1.toggle").assertDoesNotExist()
            compose.onNodeWithTag("echo.speakers.edit").performScrollTo().performClick()
            compose.onNodeWithTag("echo.speakers.none").performScrollTo().performClick()
            compose.onNodeWithTag("echo.speakers.save").performClick()
            waitText("You are not in this recording")
        }
    }
}
