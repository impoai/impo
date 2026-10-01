package ai.impo.ui

import android.content.Context
import android.content.Intent
import android.view.inputmethod.InputMethodManager
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import ai.impo.MainActivity
import ai.impo.data.AppViewModel
import ai.impo.nativebridge.RecordedVoiceClip
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL

/** Synthetic clips over the real app/client/API path. This does not validate speech recognition. */
@RunWith(AndroidJUnit4::class)
class ServerVoiceInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var scenario: ActivityScenario<MainActivity>
    private lateinit var model: AppViewModel
    private val callers = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val endpoint = "http://127.0.0.1:3011"
    private val transcript = "Android voice fixture transcript"

    @Before fun launch() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        scenario = ActivityScenario.launch(Intent(context, MainActivity::class.java).putExtra("impo.test.api", endpoint))
        attachModel()
        waitTag("chat.input")
        waitChatReady()
    }

    @After fun close() {
        callers.cancel()
        if (::scenario.isInitialized) scenario.close()
    }

    private fun attachModel() { scenario.onActivity { model = ViewModelProvider(it)[AppViewModel::class.java] } }
    private fun owner() = checkNotNull(model.state.value.account).requestScope
    private fun clip(marker: String = "IMPO_ANDROID_FIXTURE_VOICE") = RecordedVoiceClip.fromBytes(marker.toByteArray(Charsets.UTF_8))
    private fun send(marker: String = "IMPO_ANDROID_FIXTURE_VOICE"): Deferred<Boolean> {
        val account = owner()
        return callers.async { model.sendVoice(clip(marker), account) }
    }
    private fun transcribe(): String {
        val account = owner()
        return runBlocking { withTimeout(15_000) { withContext(Dispatchers.Main) { model.transcribeVoice(clip(), account) } } }
    }
    private fun waitTag(tag: String) {
        compose.waitUntil(20_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    }
    private fun waitChatReady() {
        compose.waitUntil(20_000) {
            model.state.value.chat?.state?.value?.let {
                it.conversationId != null && !it.loading && !it.busy && it.activeSubmissionIds.isEmpty() && !it.hasPendingMessage
            } == true
        }
    }
    private fun hideKeyboard() { scenario.onActivity {
        (it.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
            .hideSoftInputFromWindow(it.window.decorView.windowToken, 0)
    } }
    private fun get(path: String): JSONObject {
        val connection = URL("$endpoint/api/v1$path").openConnection() as HttpURLConnection
        connection.setRequestProperty("Authorization", "Bearer instant-dev-alice")
        connection.connectTimeout = 3_000; connection.readTimeout = 3_000
        try {
            assertEquals(200, connection.responseCode)
            return JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
        } finally { connection.disconnect() }
    }
    private fun history(path: String = "/conversation"): List<JSONObject> {
        val rows = mutableListOf<JSONObject>()
        var after = 0
        repeat(100) {
            val page = get("$path?afterSequence=$after&limit=100")
            val messages = page.getJSONArray("messages")
            repeat(messages.length()) { index -> rows += messages.getJSONObject(index) }
            if (!page.getBoolean("hasMore")) return rows
            val next = page.getInt("nextAfterSequence")
            check(next > after) { "Fixture history cursor did not advance" }
            after = next
        }
        error("Unexpected fixture history size")
    }
    private fun ids(rows: List<JSONObject>) = rows.map { it.getString("id") }.toSet()
    private fun settled(path: String = "/conversation") = get(path).getJSONArray("activeSubmissions").length() == 0
    private fun waitApi(predicate: () -> Boolean) {
        compose.waitUntil(20_000) { runCatching(predicate).getOrDefault(false) }
    }
    private fun showAcceptedMessage(messageId: String) {
        compose.waitUntil(20_000) { model.state.value.chat?.state?.value?.messages?.any { it.id == messageId } == true }
        val messages = checkNotNull(model.state.value.chat).state.value.messages
        assertEquals(1, messages.count { it.id == messageId })
        val index = messages.indexOfFirst { it.id == messageId }
        compose.onNodeWithTag("conversation.messages").performScrollToIndex(index)
        compose.onAllNodesWithText(transcript, substring = false).onLast().assertIsDisplayed()
    }

    @Test fun pendingVoiceIsAcceptedOnceAfterCallerCancellationNavigationAndActivityRecreation() {
        val before = ids(history())
        val admission = send()
        waitTag("chat.voice.pending")
        compose.onNodeWithTag("chat.voice.pending").assertIsDisplayed()
        // The released clip is owned by the account operation, so cancelling this
        // screen-level waiter must not cancel admission or turn it into a typed send.
        admission.cancel()
        compose.onNodeWithTag("nav.memories").performClick()
        waitTag("memories.echo")
        scenario.recreate()
        attachModel()
        waitTag("nav.chat")
        compose.onNodeWithTag("nav.chat").performClick()
        waitTag("chat.input")
        waitApi {
            val added = history().filter { it.getString("id") !in before }
            added.count { it.getString("role") == "user" && it.getString("text") == transcript } == 1 && settled()
        }
        waitChatReady()
        val added = history().filter { it.getString("id") !in before }
        assertEquals(2, added.size) // One accepted user message and one assistant reply.
        val user = added.single { it.getString("role") == "user" }
        assertEquals(transcript, user.getString("text"))
        showAcceptedMessage(user.getString("id"))
        compose.onNodeWithTag("chat.voice.pending").assertDoesNotExist()
        scenario.onActivity { model.retryChat() }
        waitChatReady()
        assertEquals(ids(added), ids(history()) - before)
        showAcceptedMessage(user.getString("id"))
    }

    @Test fun silenceRemovesThePendingClipAndDoesNotAcceptAnEmptyUserMessage() {
        val before = ids(history())
        val admission = send("IMPO_ANDROID_FIXTURE_SILENCE")
        waitTag("chat.voice.pending")
        compose.waitUntil(15_000) { admission.isCompleted }
        // True reports local admission; the server's 422 is represented in session state.
        assertTrue(runBlocking { admission.await() })
        compose.waitUntil(10_000) {
            model.state.value.chat?.state?.value?.let { it.pendingVoice == null && !it.hasPendingMessage && it.error != null } == true
        }
        compose.onNodeWithTag("chat.voice.pending").assertDoesNotExist()
        assertEquals(before, ids(history()))
        scenario.recreate()
        attachModel()
        waitTag("chat.input")
        waitChatReady()
        assertNull(checkNotNull(model.state.value.chat).state.value.pendingVoice)
        assertEquals(before, ids(history()))
    }

    @Test fun transcriptionOnlyLeavesChatUnchangedAndFeedsTaskCreationAndFollowup() {
        val chatBefore = ids(history())
        assertEquals(transcript, transcribe())
        assertEquals(chatBefore, ids(history()))
        compose.onNodeWithTag("chat.voice.pending").assertDoesNotExist()
        val existingTasks = get("/tasks").getJSONArray("tasks").let { rows ->
            (0 until rows.length()).map { rows.getJSONObject(it).getString("taskId") }.toSet()
        }
        compose.onNodeWithTag("nav.tasks").performClick()
        compose.onNodeWithTag("tasks.new").performClick()
        compose.onNodeWithTag("tasks.prompt").performTextInput(transcript)
        compose.onNodeWithTag("tasks.create").performClick()
        waitTag("task.input")
        hideKeyboard()
        var taskId = ""
        waitApi {
            val rows = get("/tasks").getJSONArray("tasks")
            taskId = (0 until rows.length()).map { rows.getJSONObject(it) }
                .singleOrNull { it.getString("taskId") !in existingTasks && it.getString("title") == transcript }
                ?.getString("taskId").orEmpty()
            taskId.isNotEmpty() && settled("/tasks/$taskId/conversation")
        }
        compose.waitUntil(15_000) { model.state.value.taskSession?.state?.value?.let { !it.loading && !it.busy && !it.hasPendingMessage } == true }
        val taskPath = "/tasks/$taskId/conversation"
        val taskBefore = ids(history(taskPath))
        val followup = transcribe()
        assertEquals(transcript, followup)
        assertEquals(chatBefore, ids(history()))
        compose.onNodeWithTag("task.input").performTextInput(followup)
        compose.onNodeWithTag("task.send").performClick()
        hideKeyboard()
        waitApi { history(taskPath).any { it.getString("id") !in taskBefore && it.getString("role") == "user" && it.getString("text") == transcript } && settled(taskPath) }
        val added = history(taskPath).filter { it.getString("id") !in taskBefore }
        assertEquals(2, added.size)
        assertEquals(1, added.count { it.getString("role") == "user" && it.getString("text") == transcript })
        assertEquals(chatBefore, ids(history()))
    }
}
