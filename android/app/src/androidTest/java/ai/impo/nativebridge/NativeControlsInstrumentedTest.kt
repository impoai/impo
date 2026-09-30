package ai.impo.nativebridge

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.content.ContextWrapper
import android.content.ContentResolver
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Build
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.state.ToggleableState
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import ai.impo.MainActivity
import ai.impo.ImpoApplication
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant

/** Real permission grants, AudioRecord and ongoing-notification controls on the emulator. */
@RunWith(AndroidJUnit4::class)
class NativeControlsInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val device get() = UiDevice.getInstance(instrumentation)
    private lateinit var scenario: ActivityScenario<MainActivity>
    private val notifications get() = context.getSystemService(NotificationManager::class.java)

    @Before fun launch() {
        // UI still goes through Impo's explanation and Android permission contract.
        // Granting through the OS makes this independent of previous suite runs.
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.RECORD_AUDIO)
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.READ_CALENDAR)
        if (Build.VERSION.SDK_INT >= 33) instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
        scenario = ActivityScenario.launch(Intent(context, MainActivity::class.java).putExtra("impo.test.api", "http://127.0.0.1:3011"))
        waitTag("nav.chat")
    }
    @After fun cleanup() {
        if (::scenario.isInitialized) {
            scenario.onActivity { NativeBridge.stopEcho(it) }
            compose.waitUntil(10_000) { NativeBridge.recording.value.status == "stopped" && recordingNotification() == null &&
                context.getSystemService(AudioManager::class.java).activeRecordingConfigurations.isEmpty() }
            scenario.close()
        }
    }
    private fun waitTag(tag: String) { compose.waitUntil(20_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() } }
    private fun recordingNotification() = notifications.activeNotifications.firstOrNull { it.notification.channelId == "echo_recording" }?.notification
    private fun awaitNotification(action: String): Notification {
        var observed: Notification? = null
        // NotificationManager publishes across a Binder boundary after the
        // service's local StateFlow changes. Await the actual system surface.
        compose.waitUntil(10_000) {
            observed = recordingNotification()?.takeIf { notice -> notice.actions?.any { it.title.toString() == action } == true }
            observed != null
        }
        return checkNotNull(observed)
    }
    private fun sendNotificationAction(action: String) {
        // Select from the same observed snapshot; don't race another lookup
        // between checking the action and obtaining its real PendingIntent.
        val notice = awaitNotification(action)
        checkNotNull(notice.actions.firstOrNull { it.title.toString() == action }).actionIntent.send()
    }

    @Test fun microphoneStartsFromUiAndNotificationControlsWorkInBackground() {
        compose.onNodeWithTag("nav.memories").performClick()
        waitTag("echo.start")
        compose.onNodeWithTag("echo.start").performClick()
        compose.onNodeWithText("Start recording").performClick()
        compose.waitUntil(25_000) { NativeBridge.recording.value.isRecording && context.getSystemService(AudioManager::class.java).activeRecordingConfigurations.isNotEmpty() }
        val notice = awaitNotification("Pause")
        assertTrue(notice.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertEquals(setOf("Pause", "Stop"), notice.actions.map { it.title.toString() }.toSet())
        compose.onNodeWithContentDescription("Pause Echo").performClick()
        compose.waitUntil(10_000) { NativeBridge.recording.value.isPaused && context.getSystemService(AudioManager::class.java).activeRecordingConfigurations.isEmpty() }
        assertEquals(setOf("Resume", "Stop"), awaitNotification("Resume").actions.map { it.title.toString() }.toSet())
        compose.onNodeWithContentDescription("Resume Echo").performClick()
        compose.waitUntil(15_000) { NativeBridge.recording.value.isRecording && context.getSystemService(AudioManager::class.java).activeRecordingConfigurations.isNotEmpty() }

        device.pressHome()
        awaitNotification("Pause")
        assertTrue(NativeBridge.recording.value.isRecording)
        sendNotificationAction("Pause")
        compose.waitUntil(10_000) { NativeBridge.recording.value.isPaused }
        sendNotificationAction("Resume")
        compose.waitUntil(15_000) { NativeBridge.recording.value.isRecording && context.getSystemService(AudioManager::class.java).activeRecordingConfigurations.isNotEmpty() }
        sendNotificationAction("Stop")
        compose.waitUntil(10_000) { NativeBridge.recording.value.status == "stopped" && recordingNotification() == null }
    }

    @Test fun calendarRequiresExplicitConnectionAndReadsTheRealProviderWithoutWriting() {
        compose.onNodeWithTag("settings.open").performClick()
        compose.onNodeWithTag("settings.connections").performScrollTo().performClick()
        waitTag("connections.calendar")
        // Reset this opt-in through its actual UI if a previous run left it enabled.
        val toggle = compose.onNodeWithTag("connections.calendar")
        val on = toggle.fetchSemanticsNode().config[SemanticsProperties.ToggleableState] == ToggleableState.On
        fun checked(value: Boolean) = hasTestTag("connections.calendar") and SemanticsMatcher.expectValue(SemanticsProperties.ToggleableState, if (value) ToggleableState.On else ToggleableState.Off)
        if (on) { toggle.performClick(); compose.waitUntil(10_000) { compose.onAllNodes(checked(false)).fetchSemanticsNodes().isNotEmpty() } }
        toggle.performClick()
        compose.onNodeWithText("Connect Calendar?").assertExists()
        compose.onNodeWithText("Choose read permissions").performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(checked(true)).fetchSemanticsNodes().isNotEmpty() }
        val output = runBlocking {
            val end = Instant.now()
            DeviceDataAdapter(context).execute(DeviceDataAdapter.CALENDAR_TOOL, buildJsonObject {
                put("start", end.minusSeconds(86400).toString()); put("end", end.toString()); put("time_zone", "UTC"); put("limit", 5)
            })
        }
        assertEquals("android.calendar_provider", output["source"]!!.jsonPrimitive.content)
        assertFalse(output["notes_included"]!!.jsonPrimitive.boolean)
        assertTrue(output["returned_count"]!!.jsonPrimitive.int in 0..5)
        toggle.performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(checked(false)).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test fun contactsRequireConsentAndGrantedReadAccessAndDisconnectFiltersTheTool() {
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.READ_CONTACTS)
        val adapter = DeviceDataAdapter(context)
        assertTrue(adapter.contactsGranted)
        assertFalse(runBlocking { adapter.enabledTools(false, false, false) }.contains(DeviceDataAdapter.CONTACTS_TOOL))
        compose.onNodeWithTag("settings.open").performClick()
        compose.onNodeWithTag("settings.connections").performScrollTo().performClick()
        waitTag("connections.contacts")
        val toggle = compose.onNodeWithTag("connections.contacts")
        fun checked(value: Boolean) = hasTestTag("connections.contacts") and SemanticsMatcher.expectValue(
            SemanticsProperties.ToggleableState, if (value) ToggleableState.On else ToggleableState.Off)
        if (toggle.fetchSemanticsNode().config[SemanticsProperties.ToggleableState] == ToggleableState.On) {
            toggle.performScrollTo().performClick()
            compose.waitUntil(10_000) { compose.onAllNodes(checked(false)).fetchSemanticsNodes().isNotEmpty() }
        }
        toggle.performScrollTo().performClick()
        compose.onNodeWithText("Connect Contacts?").assertExists()
        // Dismissing the explanation cannot enable access just because the OS grant exists.
        compose.onNodeWithText("Not now").performClick()
        compose.onNode(checked(false)).assertExists()
        toggle.performClick()
        compose.onNodeWithText("Choose read permissions").performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(checked(true)).fetchSemanticsNodes().isNotEmpty() }

        val application = context.applicationContext as ImpoApplication
        val accountId = checkNotNull(application.auth.state.value.account).id
        fun enabledTools() = runBlocking {
            val settings = application.settings.observe(accountId).first()
            adapter.enabledTools(settings.calendarEnabled, settings.healthEnabled, settings.contactsEnabled)
        }
        assertTrue(enabledTools().contains(DeviceDataAdapter.CONTACTS_TOOL))
        val output = runBlocking { adapter.execute(DeviceDataAdapter.CONTACTS_TOOL, buildJsonObject {
            put("query", "Impo native contact test"); put("limit", 5)
        }) }
        assertEquals("android.contacts_provider", output["source"]!!.jsonPrimitive.content)
        assertFalse(output["notes_included"]!!.jsonPrimitive.boolean)
        assertEquals(output["contacts"]!!.jsonArray.size, output["returned_count"]!!.jsonPrimitive.int)
        assertTrue(output["returned_count"]!!.jsonPrimitive.int in 0..5)
        assertTrue(output.toString().toByteArray(Charsets.UTF_8).size <= 48 * 1024)
        toggle.performScrollTo().performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(checked(false)).fetchSemanticsNodes().isNotEmpty() }
        assertTrue(adapter.contactsGranted) // Impo's opt-in does not change Android's permission grant.
        assertFalse(enabledTools().contains(DeviceDataAdapter.CONTACTS_TOOL))

        // Model a revoked grant without killing the instrumentation process. A denied
        // permission must prevent both capability advertisement and every provider read.
        val denied = DeviceDataAdapter(object : ContextWrapper(context) {
            override fun checkPermission(permission: String, pid: Int, uid: Int): Int =
                if (permission == Manifest.permission.READ_CONTACTS) PackageManager.PERMISSION_DENIED else super.checkPermission(permission, pid, uid)
            override fun getContentResolver(): ContentResolver = error("A denied Contacts grant must not query the provider")
        })
        assertFalse(runBlocking { denied.enabledTools(false, false, true) }.contains(DeviceDataAdapter.CONTACTS_TOOL))
        val failure = assertThrows(IllegalStateException::class.java) { runBlocking {
            denied.execute(DeviceDataAdapter.CONTACTS_TOOL, buildJsonObject { put("query", "Someone"); put("limit", 5) })
        } }
        assertEquals("permission_required", failure.message)
    }

    @Test fun revokingNativeAccessDoesNotWaitForAnInFlightInvocation() {
        val account = checkNotNull(NativeBridge.account())
        val preferenceName = "native_revocation_test_${java.util.UUID.randomUUID()}"
        val preferences = context.getSharedPreferences(preferenceName, Context.MODE_PRIVATE)
        val isolatedContext = object : ContextWrapper(context) {
            override fun getApplicationContext(): Context = this
            override fun getSharedPreferences(name: String, mode: Int) = preferences
        }
        val key = "contacts_${sha256(account.accountId.toByteArray())}"
        assertTrue(preferences.edit().putBoolean(key, true).commit())
        val heldByInvocation = Mutex(locked = true)
        val coordinator = DeviceCoordinator(isolatedContext, heldByInvocation)
        try {
            runBlocking {
                val update = launch(Dispatchers.Default) { coordinator.configure(false, false, false) }
                try {
                    withTimeout(5_000) { while (preferences.getBoolean(key, true)) delay(10) }
                    // Registration is still waiting behind the invocation; its permission
                    // recheck must already observe the user's revocation at this point.
                    assertTrue(update.isActive)
                    assertFalse(preferences.getBoolean(key, true))
                } finally { update.cancelAndJoin() }
            }
        } finally {
            heldByInvocation.unlock()
            preferences.edit().clear().commit()
        }
    }
}
