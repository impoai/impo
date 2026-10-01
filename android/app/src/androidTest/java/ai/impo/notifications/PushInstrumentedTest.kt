package ai.impo.notifications

import android.app.Notification
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
    private val openedEventId = UUID.randomUUID().toString()
    private lateinit var scenario: ActivityScenario<MainActivity>
    @Before fun launch() {
        device.executeShellCommand("pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS")
        // ActivityScenario tracks Intent identity, including when the tested tap resumes it.
        scenario = ActivityScenario.launch(Intent(context, MainActivity::class.java)
            .setAction("ai.impo.NOTIFICATION.$openedEventId").putExtra("impo.test.api", "http://127.0.0.1:3011"))
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
        "expiresAt" to Instant.now().plusSeconds(3600).toString(), "title" to "You have a new reply", "body" to "Tap to read it.")
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
        val allowed = message() + ("eventId" to openedEventId)
        app.push.receive(allowed); app.push.receive(allowed)
        compose.waitUntil(5000) { manager.activeNotifications.size == 1 }
        assertEquals("impo_chat", manager.activeNotifications.single().notification.channelId)
        manager.activeNotifications.single().notification.contentIntent.send()
        compose.waitUntil(10_000) { app.push.route.value == null && compose.onAllNodesWithTag("chat.input").fetchSemanticsNodes().isNotEmpty() }
        // A notification uses its own intent identity; ActivityScenario follows the launch intent.
        InstrumentationRegistry.getInstrumentation().runOnMainSync { app.push.set("tasks", true) }
    }

    @Test fun serverCopyPreservesBriefAndFailureMeaningAndIncompletePayloadCanRetry() {
        device.pressHome(); compose.waitForIdle()
        scenario.onActivity { app.push.foreground(false) }
        val brief = message("brief") + mapOf("title" to "You have a brief", "body" to "Tap to read it.")
        val failed = message("tasks") + mapOf("title" to "Your task couldn't finish", "body" to "Tap to open the task.")
        app.push.receive(brief - "title")
        app.push.receive(brief + ("body" to " "))
        assertTrue(manager.activeNotifications.isEmpty())
        for (payload in listOf(brief, failed)) {
            app.push.receive(payload)
            compose.waitUntil(5000) { manager.activeNotifications.any { it.tag == payload["eventId"] } }
            val notification = manager.activeNotifications.single { it.tag == payload["eventId"] }.notification
            assertEquals(payload["title"], notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString())
            assertEquals(payload["body"], notification.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString())
        }
    }

    @Test fun notificationsWithCollidingHashCodesKeepSeparateTapDestinations() {
        device.pressHome(); compose.waitForIdle()
        scenario.onActivity { app.push.foreground(false) }
        val first = "2086b883-938e-4bc6-8022-7dc92935bcb8"
        val second = "e1862e26-21d4-4131-a89d-d6d3ae498841"
        assertEquals(first.hashCode(), second.hashCode())
        // Preserve the known collision while avoiding the persistent dedupe cache on reruns.
        context.getSharedPreferences("impo_push", Context.MODE_PRIVATE).edit().remove("seen").commit()
        app.push.receive(message() + ("eventId" to first))
        app.push.receive(message() + ("eventId" to second))
        compose.waitUntil(5000) { manager.activeNotifications.size == 2 }
        val alerts = manager.activeNotifications.associateBy { it.tag }
        assertNotEquals(alerts.getValue(first).notification.contentIntent, alerts.getValue(second).notification.contentIntent)
    }
}
