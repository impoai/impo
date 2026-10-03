package ai.impo.ui

import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import ai.impo.MainActivity
import java.net.HttpURLConnection
import java.net.URL
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Start the task-list fixture on port 3022 and reverse that port before running. */
@RunWith(AndroidJUnit4::class) class TaskLoadingInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()
    @Test fun loadingAndFailuresNeverPretendTheTaskListIsEmpty() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, MainActivity::class.java).putExtra("impo.test.api", "http://127.0.0.1:3022")
        control("hold")
        ActivityScenario.launch<MainActivity>(intent).use {
            openTasks()
            compose.onNodeWithText("Make room for your day").assertDoesNotExist()
            control("rows")
            awaitText("Existing research task")
            control("hold")
            compose.onNodeWithContentDescription("Refresh tasks").performClick()
            compose.onNodeWithText("Existing research task").assertExists()
            compose.onNodeWithText("Make room for your day").assertDoesNotExist()
            control("error")
            awaitText("Tasks are temporarily unavailable.")
            compose.onNodeWithText("Existing research task").assertExists()
        }
        control("error")
        ActivityScenario.launch<MainActivity>(intent).use {
            openTasks()
            awaitText("Tasks are temporarily unavailable.")
            compose.onNodeWithText("Make room for your day").assertDoesNotExist()
            control("hold")
            compose.onNodeWithContentDescription("Refresh tasks").performClick()
            compose.onNodeWithText("Make room for your day").assertDoesNotExist()
            control("empty")
            awaitText("Make room for your day")
            compose.onNodeWithText("Tasks are temporarily unavailable.").assertDoesNotExist()
        }
    }
    private fun openTasks() {
        compose.waitUntil(20_000) { compose.onAllNodesWithTag("nav.tasks").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("nav.tasks").performClick()
    }
    private fun awaitText(value: String) {
        compose.waitUntil(15_000) { compose.onAllNodesWithText(value).fetchSemanticsNodes().isNotEmpty() }
    }
    private fun control(mode: String) {
        val connection = URL("http://127.0.0.1:3022/fixture/tasks?mode=$mode").openConnection() as HttpURLConnection
        try { connection.requestMethod = "POST"; connection.connectTimeout = 5_000; connection.readTimeout = 5_000; assertEquals(200, connection.responseCode) }
        finally { connection.disconnect() }
    }
}
