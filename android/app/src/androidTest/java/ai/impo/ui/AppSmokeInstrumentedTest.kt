package ai.impo.ui

import android.content.Context
import android.content.Intent
import android.view.inputmethod.InputMethodManager
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import ai.impo.MainActivity
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/** Real Compose/native UI over the production HTTP/SSE adapter and local synthetic fixture. */
@RunWith(AndroidJUnit4::class)
class AppSmokeInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var scenario: ActivityScenario<MainActivity>
    private val device get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val endpoint = "http://127.0.0.1:3011"

    @Before fun launch() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        scenario = ActivityScenario.launch(Intent(context, MainActivity::class.java).putExtra("impo.test.api", endpoint))
        waitTag("nav.chat")
    }
    @After fun close() { if (::scenario.isInitialized) scenario.close() }
    private fun waitTag(tag: String) {
        try { compose.waitUntil(20_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() } }
        catch (failure: ComposeTimeoutException) {
            compose.onRoot(useUnmergedTree = true).printToLog("ImpoSmokeMissing:$tag")
            throw failure
        }
    }
    private fun hideKeyboard() { scenario.onActivity { activity -> (activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(activity.window.decorView.windowToken, 0) } }
    private fun get(path: String): JSONObject {
        val connection = URL("$endpoint/api/v1$path").openConnection() as HttpURLConnection
        connection.setRequestProperty("Authorization", "Bearer instant-dev-alice")
        connection.connectTimeout = 3_000; connection.readTimeout = 3_000
        try { assertEquals(200, connection.responseCode); return JSONObject(connection.inputStream.bufferedReader().use { it.readText() }) }
        finally { connection.disconnect() }
    }
    private fun waitApi(predicate: () -> Boolean) { compose.waitUntil(20_000) { runCatching(predicate).getOrDefault(false) } }
    private fun finished(path: String = "/conversation"): Boolean {
        val conversation = get(path); val messages = conversation.getJSONArray("messages")
        return messages.length() > 0 && messages.getJSONObject(messages.length() - 1).getString("status") == "completed" && conversation.getJSONArray("activeSubmissions").length() == 0
    }

    @Test fun chatTasksBriefMemoriesAndEchoCompleteTheirMainFlows() {
        val message = "Hello Android — 你好 👋 ${UUID.randomUUID()}"
        compose.onNodeWithTag("chat.input").performTextInput(message)
        compose.onNodeWithTag("chat.send").performClick()
        hideKeyboard()
        waitApi { val rows = get("/conversation").getJSONArray("messages"); rows.length() >= 4 && rows.getJSONObject(rows.length() - 2).getString("text") == message && finished() }
        waitTag("chat.send")
        compose.onNodeWithTag("conversation.messages").performScrollToIndex(get("/conversation").getJSONArray("messages").length() - 1)
        assertTrue(device.wait(Until.hasObject(By.textContains("Hello Android")), 10_000))
        scenario.recreate()
        waitTag("chat.input")
        waitApi { finished() }
        assertTrue(device.wait(Until.hasObject(By.textContains("Hello Android")), 10_000))

        compose.onNodeWithTag("chat.input").performTextInput("slow reply for explicit Android cancellation")
        compose.onNodeWithTag("chat.send").performClick()
        waitTag("chat.cancel")
        compose.onNodeWithTag("chat.cancel").performClick()
        hideKeyboard()
        waitApi { val rows = get("/conversation").getJSONArray("messages"); rows.getJSONObject(rows.length() - 1).getString("status") == "cancelled" }

        compose.onNodeWithTag("nav.tasks").performClick()
        compose.onNodeWithTag("tasks.new").performClick()
        val taskTitle = "Plan a quiet Android weekend ${UUID.randomUUID().toString().take(8)}"
        compose.onNodeWithTag("tasks.prompt").performTextInput(taskTitle)
        compose.onNodeWithTag("tasks.create").performClick()
        waitTag("task.input"); hideKeyboard()
        var taskId = ""
        waitApi {
            val tasks = get("/tasks").getJSONArray("tasks")
            taskId = (0 until tasks.length()).map { tasks.getJSONObject(it) }.find { it.getString("title") == taskTitle }?.getString("taskId").orEmpty()
            taskId.isNotEmpty() && finished("/tasks/$taskId/conversation")
        }
        compose.onNodeWithTag("task.input").performTextInput("Add a riverside walking break.")
        compose.onNodeWithTag("task.send").performClick(); hideKeyboard()
        waitApi { val rows = get("/tasks/$taskId/conversation").getJSONArray("messages"); rows.length() >= 4 && rows.getJSONObject(rows.length() - 2).getString("text") == "Add a riverside walking break." && finished("/tasks/$taskId/conversation") }
        compose.onNodeWithContentDescription("Back").performClick()
        waitTag("nav.brief")
        compose.onNodeWithTag("nav.brief").performClick()
        waitTag("brief.list")
        compose.onNodeWithText("Make room for a good day").assertExists()
        val brief = get("/today/briefs").getJSONArray("briefs").getJSONObject(0)
        val sourceId = brief.getJSONArray("sources").getJSONObject(0).getString("recordId")
        compose.onAllNodesWithTag("brief.source.$sourceId").onFirst().performScrollTo().performClick()
        compose.onNodeWithText("Original source").assertExists()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Leave a little room this afternoon. Take the long way home and stop for coffee. [Echo 1]").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Back").performClick()

        compose.onNodeWithTag("nav.memories").performClick()
        compose.onNodeWithTag("memories.about").performClick()
        waitTag("memories.list")
        val memoryCount = get("/memories/summary").getInt("total")
        val memory = get("/memories").getJSONArray("memories").getJSONObject(0)
        val memoryId = memory.getString("id")
        waitTag("memory.$memoryId")
        compose.onNodeWithText(memory.getString("content")).assertExists()
        compose.onNode(hasContentDescription("Forget memory") and hasAnyAncestor(hasTestTag("memory.$memoryId"))).performClick()
        compose.onNodeWithTag("confirm.delete").performClick()
        waitApi { get("/memories/summary").getInt("total") == memoryCount - 1 }
        compose.onNodeWithTag("memories.echo").performClick()
        // Operate on this Brief's source even if a native capture test added a newer Echo.
        val recordId = sourceId
        val timeline = get("/listening/timeline?timeZone=${java.net.URLEncoder.encode(java.time.ZoneId.systemDefault().id, "UTF-8")}").getJSONArray("days")
        val timelineKeys = (0 until timeline.length()).flatMap { dayIndex ->
            val day = timeline.getJSONObject(dayIndex)
            val ids = day.getJSONArray("ids")
            listOf("day:${day.getString("date")}") + (0 until ids.length()).map(ids::getString)
        }
        val recordIndex = timelineKeys.indexOf(recordId)
        assertTrue(recordIndex >= 0)
        compose.onNodeWithTag("echo.list").performScrollToIndex(recordIndex)
        waitTag("echo.$recordId")
        compose.onNodeWithTag("echo.$recordId").performClick()
        waitTag("echo.transcript")
        compose.onNodeWithTag("echo.label").performScrollTo().performClick()
        compose.onNodeWithTag("echo.label.input").performTextReplacement("Android morning walk")
        compose.onNodeWithTag("echo.label.save").performClick(); hideKeyboard()
        waitApi { get("/listening/segments?ids=$recordId").getJSONArray("segments").getJSONObject(0).getJSONObject("location").getString("label") == "Android morning walk" }
        compose.onNodeWithText("Android morning walk").assertExists()
        compose.onNodeWithContentDescription("Delete Echo").performClick()
        compose.onNodeWithTag("confirm.delete").performClick()
        waitTag("echo.list")
        waitApi { get("/listening/segments?ids=$recordId").getJSONArray("segments").length() == 0 }
        assertEquals("withdrawn", get("/today/briefs/${brief.getString("id")}").getString("status"))
    }
    @Test fun preferencesPersistAndEchoCanJumpBeyondTheInitialThirtyRecords() {
        compose.onNodeWithTag("nav.brief").performClick()
        compose.onNodeWithTag("brief.settings").performClick()
        compose.onNodeWithTag("briefSettings.name").performTextReplacement("Android Brief Reader")
        compose.onNodeWithTag("briefSettings.locale").performTextReplacement("en-GB")
        compose.onNodeWithTag("briefSettings.zone").performScrollTo().performTextReplacement("Asia/Tokyo")
        compose.onNodeWithTag("briefSettings.city").performScrollTo().performTextReplacement("Tokyo")
        compose.onNodeWithTag("briefSettings.country").performScrollTo().performTextReplacement("Japan")
        hideKeyboard()
        compose.onNodeWithTag("briefSettings.save").performScrollTo().performClick()
        waitTag("brief.list")
        val settings = get("/today/settings").getJSONObject("settings")
        assertEquals("Android Brief Reader", settings.getString("displayName"))
        assertEquals("en-GB", settings.getString("locale"))
        assertEquals("Asia/Tokyo", settings.getString("timeZone"))
        assertEquals("Tokyo", settings.getJSONObject("location").getString("city"))
        assertEquals("manual", settings.getJSONObject("location").getString("source"))
        compose.onNodeWithTag("brief.settings").performClick()
        compose.onNodeWithTag("briefSettings.name").assertTextContains("Android Brief Reader")
        compose.onNodeWithTag("briefSettings.locale").assertTextContains("en-GB")
        compose.onNodeWithContentDescription("Back").performClick()

        compose.onNodeWithTag("nav.chat").performClick()
        compose.onNodeWithTag("settings.open").performClick()
        compose.onNodeWithText("Your assistant").performClick()
        compose.onNodeWithTag("onboarding.name").performTextReplacement("Android Explorer")
        compose.onNodeWithTag("onboarding.assistant").performTextReplacement("Robin Android")
        hideKeyboard()
        compose.onNodeWithTag("onboarding.continue").performScrollTo().performClick()
        compose.onNodeWithContentDescription("Back").performClick()
        waitTag("nav.chat")
        scenario.recreate()
        waitTag("chat.input")
        compose.onNodeWithText("Robin Android").assertExists()
        compose.onNodeWithTag("settings.open").performClick()
        compose.onNodeWithText("Android Explorer").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("nav.memories").performClick()
        compose.onNodeWithTag("memories.echo").performClick()
        val days = get("/listening/timeline?timeZone=UTC").getJSONArray("days")
        assertTrue(days.length() >= 3)
        val oldest = days.getJSONObject(days.length() - 1)
        val firstOldRecord = oldest.getJSONArray("ids").getString(0)
        compose.onNodeWithTag("echo.dates").performClick()
        compose.onNodeWithText("${oldest.getString("date")} · ${oldest.getJSONArray("ids").length()}").performClick()
        waitTag("echo.$firstOldRecord")
        compose.onNodeWithTag("echo.$firstOldRecord").assertIsDisplayed().performClick()
        waitTag("echo.transcript")
        val record = get("/listening/segments?ids=$firstOldRecord").getJSONArray("segments").getJSONObject(0)
        compose.onNodeWithTag("echo.transcript").assertTextEquals(record.getString("transcript"))
    }

    @Test fun connectorBrowserAuthorizationIsConfirmedOnReturnAndCanBeDisconnected() {
        compose.onNodeWithTag("settings.open").performClick()
        compose.onNodeWithTag("settings.connections").performClick()
        compose.onNodeWithTag("connections.search").performScrollTo().performTextInput("Gmail")
        hideKeyboard()
        waitTag("connector.gmail")
        fun disconnect() {
            compose.onNode(hasText("Disconnect") and hasAnyAncestor(hasTestTag("connector.gmail"))).performScrollTo().performClick()
            compose.onAllNodesWithText("Disconnect").onLast().performClick()
            waitApi { get("/connectors/gmail").getString("status") == "disconnected" }
            compose.waitUntil(10_000) { compose.onAllNodes(hasText("Connect") and hasAnyAncestor(hasTestTag("connector.gmail"))).fetchSemanticsNodes().isNotEmpty() }
        }
        if (get("/connectors/gmail").getString("status") == "connected") disconnect()
        compose.onNode((hasText("Connect") or hasText("Reconnect") or hasText("Continue connection")) and hasAnyAncestor(hasTestTag("connector.gmail"))).performScrollTo().performClick()
        // This browser is the fixture's explicit synthetic authorization form, never a real provider.
        val deadline = System.currentTimeMillis() + 30_000
        var authorized = false
        while (System.currentTimeMillis() < deadline && !authorized) {
            val button = device.findObject(By.text("Connect development account"))
            if (button != null) { button.click(); authorized = device.wait(Until.hasObject(By.textContains("Development connection ready")), 5_000) }
            else {
                listOf("Use without an account", "Accept & continue", "No thanks", "Got it").firstNotNullOfOrNull { label -> device.findObject(By.pkg("com.android.chrome").text(label)) }?.click()
                Thread.sleep(150)
            }
        }
        assertTrue("Synthetic authorization page should open and accept its development account", authorized)
        assertEquals("connected", get("/connectors/gmail").getString("status"))
        val appPackage = InstrumentationRegistry.getInstrumentation().targetContext.packageName
        // Custom Tabs can leave the app's accessibility tree behind their window.
        // Return until Impo is actually foreground, so its resume refresh runs.
        repeat(3) { if (device.currentPackageName != appPackage) { device.pressBack(); device.waitForIdle(1_000) } }
        assertEquals(appPackage, device.currentPackageName)
        waitTag("connector.gmail")
        try {
            compose.waitUntil(10_000) { compose.onAllNodes(hasText("Disconnect") and hasAnyAncestor(hasTestTag("connector.gmail"))).fetchSemanticsNodes().isNotEmpty() }
        } catch (failure: ComposeTimeoutException) {
            compose.onRoot(useUnmergedTree = true).printToLog("ImpoConnectorReturn")
            throw failure
        }
        disconnect()
    }

}
