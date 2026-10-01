package ai.impo.notifications

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import ai.impo.ImpoApplication
import ai.impo.MainActivity
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.net.URL
import java.net.HttpURLConnection
import java.time.Instant
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class PushInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val app get() = context.applicationContext as ImpoApplication
    private val manager get() = context.getSystemService(NotificationManager::class.java)
    private val device get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private lateinit var scenario: ActivityScenario<MainActivity>
    @Before fun launch() {
        device.executeShellCommand("pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS")
        scenario = ActivityScenario.launch(Intent(context, MainActivity::class.java).putExtra("impo.test.api", "http://127.0.0.1:3011"))
        compose.waitUntil(20_000) { app.push.state.value.loaded }
        scenario.onActivity { for (category in listOf("chat", "tasks", "brief")) app.push.set(category, true) }
        compose.waitUntil(20_000) { settings().getBoolean("chat") && settings().getBoolean("tasks") && settings().getBoolean("brief") }
    }
    @After fun close() { manager.cancelAll(); if (::scenario.isInitialized) scenario.close() }
    private fun settings(): JSONObject {
        val connection = URL("http://127.0.0.1:3011/api/v1/notifications/settings").openConnection() as HttpURLConnection
        connection.setRequestProperty("Authorization", "Bearer instant-dev-alice")
        connection.connectTimeout = 3000; connection.readTimeout = 3000
        return try { JSONObject(connection.inputStream.bufferedReader().use { it.readText() }) } finally { connection.disconnect() }
    }
    private fun message(category: String = "chat") = mapOf("version" to "1", "category" to category, "eventId" to UUID.randomUUID().toString(),
        "targetId" to UUID.randomUUID().toString(), "registrationId" to context.getSharedPreferences("impo_push", Context.MODE_PRIVATE).getString("registration", null)!!,
        "expiresAt" to Instant.now().plusSeconds(3600).toString())
    @Test fun categorySwitchSyncsAndSurvivesActivityRecreation() {
        compose.onNodeWithTag("settings.open").performClick()
        compose.onNodeWithTag("notifications.tasks").performScrollTo().assertIsOn().performClick()
        compose.waitUntil(20_000) { !settings().getBoolean("tasks") }
        scenario.recreate()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("notifications.tasks").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("notifications.tasks").performScrollTo().assertIsOff()
        compose.onNodeWithTag("notifications.tasks").performClick()
        compose.waitUntil(20_000) { settings().getBoolean("tasks") }
    }
    @Test fun nativeReceiverSuppressesForegroundDisabledExpiredAndOldAccountMessages() {
        val suppressed = message()
        app.push.receive(suppressed)
        assertTrue(manager.activeNotifications.isEmpty())
        device.pressHome(); compose.waitForIdle()
        scenario.onActivity { app.push.foreground(false); app.push.set("tasks", false) }
        app.push.receive(message("tasks"))
        app.push.receive(message() + ("expiresAt" to Instant.now().minusSeconds(1).toString()))
        app.push.receive(message() + ("registrationId" to UUID.randomUUID().toString()))
        app.push.receive(suppressed) // A foreground-suppressed event is never backfilled.
        assertTrue(manager.activeNotifications.isEmpty())
        val allowed = message()
        app.push.receive(allowed); app.push.receive(allowed)
        compose.waitUntil(5000) { manager.activeNotifications.size == 1 }
        assertEquals("impo_chat", manager.activeNotifications.single().notification.channelId)
        manager.activeNotifications.single().notification.contentIntent.send()
        compose.waitUntil(10_000) { app.push.route.value == null && compose.onAllNodesWithTag("chat.input").fetchSemanticsNodes().isNotEmpty() }
        scenario.onActivity { app.push.set("tasks", true) }
    }
}
