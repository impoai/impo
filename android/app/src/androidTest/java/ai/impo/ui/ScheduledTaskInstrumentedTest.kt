package ai.impo.ui

import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import ai.impo.MainActivity
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class) class ScheduledTaskInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()
    @Test fun createPauseReloadAndDeleteSchedule() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("impo.test.api", "http://127.0.0.1:3011")).use { scenario ->
            compose.waitUntil(20_000) { compose.onAllNodesWithTag("nav.tasks").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("nav.tasks").performClick(); compose.onNodeWithTag("tasks.scheduled").performClick()
            compose.onNodeWithTag("schedule.new").performClick()
            compose.onNodeWithTag("schedule.title").performTextInput("Morning research")
            compose.onNodeWithTag("schedule.goal").performTextInput("Research the latest AI news and cite sources.")
            compose.onNodeWithTag("schedule.save").performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Morning research").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("Morning research").performClick()
            compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("schedule.enabled") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("schedule.enabled").performScrollTo().performClick()
            compose.onNodeWithTag("schedule.save").performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Paused").fetchSemanticsNodes().isNotEmpty() }
            scenario.recreate()
            compose.onNodeWithText("Morning research").performClick()
            compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("schedule.enabled") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("schedule.enabled").performScrollTo().assertIsOff()
            compose.onNodeWithTag("schedule.delete").performScrollTo().performClick()
            compose.onAllNodesWithText("Delete schedule").onLast().performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithTag("schedule.new").fetchSemanticsNodes().isNotEmpty() }
            compose.onAllNodesWithText("Morning research").assertCountEquals(0)
        }
    }
}
