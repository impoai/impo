package ai.impo.ui

import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import ai.impo.MainActivity
import ai.impo.ImpoApplication
import ai.impo.data.SoftUpgrade
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SoftUpgradeInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()
    @Test fun laterKeepsAppUsableAndDoesNotRepeatAfterRecreationOrForegroundReturn() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        // Give this case a fresh process controller, independent of suite order.
        InstrumentationRegistry.getInstrumentation().runOnMainSync { (context.applicationContext as ImpoApplication).upgrade = SoftUpgrade() }
        val release = """{"schemaVersion":1,"platform":"android","channel":"apk","latest":{"version":"0.1.5","build":999,"minimumSystemVersion":"28","url":"https://impo.ai/android.apk"}}"""
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)
            .putExtra("impo.test.api", "http://127.0.0.1:3011").putExtra("impo.test.release", release)).use { scenario ->
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Update available").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("Update").assertIsDisplayed()
            compose.onNodeWithText("Later").performClick()
            compose.onNodeWithText("Update available").assertDoesNotExist()
            compose.waitUntil(20_000) { compose.onAllNodesWithTag("chat.input").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("chat.input").performTextInput("I can keep using Impo")
            scenario.recreate()
            scenario.moveToState(Lifecycle.State.CREATED); scenario.moveToState(Lifecycle.State.RESUMED)
            compose.onNodeWithText("Update available").assertDoesNotExist()
            compose.onNodeWithTag("chat.input").assertExists()
        }
    }
}
