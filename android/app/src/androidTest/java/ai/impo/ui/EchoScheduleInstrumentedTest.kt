package ai.impo.ui

import android.Manifest
import android.content.Intent
import android.media.AudioManager
import android.app.NotificationManager
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import ai.impo.ImpoApplication
import ai.impo.MainActivity
import ai.impo.nativebridge.NativeBridge
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.time.*
import java.time.format.DateTimeFormatter

@RunWith(AndroidJUnit4::class) class EchoScheduleInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()
    @Test fun ownedSchedulePersistsAndStopsRealBackgroundMicrophone() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val app = context.applicationContext as ImpoApplication
        val device = UiDevice.getInstance(instrumentation)
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.RECORD_AUDIO)
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("impo.test.api", "http://127.0.0.1:3011")).use { scenario ->
            compose.waitUntil(20_000) { compose.onAllNodesWithTag("nav.memories").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("nav.memories").performClick()
            compose.onNodeWithTag("echo.schedule.open").performClick()
            compose.waitUntil(20_000) { app.echoSchedule.state.value.loaded }
            val original = app.echoSchedule.state.value.schedule
            try {
                if (!original.enabled) compose.onNodeWithTag("echo.schedule.enabled").performClick()
                compose.onNodeWithTag("echo.schedule.day.6").performScrollTo().performClick()
                compose.onNodeWithTag("echo.schedule.save").performClick()
                compose.waitUntil(10_000) { app.echoSchedule.state.value.schedule.revision != original.revision }
                assertTrue(app.echoSchedule.state.value.schedule.enabled)
                assertEquals(6 !in original.weekdays, 6 in app.echoSchedule.state.value.schedule.weekdays)
                assertFalse(NativeBridge.recording.value.isRecording)
                scenario.recreate()
                compose.onNodeWithTag("echo.schedule.open").performClick()
                compose.onNodeWithTag("echo.schedule.enabled").assertIsOn()
                device.pressBack()
                // Use the real minute-resolution schedule, service, clock, AudioRecord and system notification.
                val stop = Instant.now().plusSeconds(75).atZone(ZoneOffset.UTC).withSecond(0).withNano(0)
                assertNotEquals("00:00", stop.format(DateTimeFormatter.ofPattern("HH:mm")))
                runBlocking { withContext(Dispatchers.Main) {
                    assertTrue(app.echoSchedule.save(app.echoSchedule.state.value.schedule.copy(enabled = true, autoStop = true,
                        weekdays = (1..7).toList(), reminderTime = "00:00", stopTime = stop.format(DateTimeFormatter.ofPattern("HH:mm")), timeZone = "UTC")))
                } }
                compose.onNodeWithTag("echo.start").performClick(); compose.onNodeWithText("Start recording").performClick()
                compose.waitUntil(20_000) { NativeBridge.recording.value.isRecording && context.getSystemService(AudioManager::class.java).activeRecordingConfigurations.isNotEmpty() }
                assertEquals(stop.toInstant(), NativeBridge.recording.value.scheduledStopAt)
                device.pressHome()
                compose.waitUntil(85_000) { NativeBridge.recording.value.status == "stopped" }
                compose.waitUntil(10_000) { context.getSystemService(AudioManager::class.java).activeRecordingConfigurations.isEmpty() && context.getSystemService(NotificationManager::class.java).activeNotifications.none { it.notification.channelId == "echo_recording" } }
                assertEquals("Echo stopped at your scheduled time.", NativeBridge.recording.value.message)
            } finally {
                instrumentation.runOnMainSync { NativeBridge.stopEcho(context) }
                runBlocking { withContext(Dispatchers.Main) { app.echoSchedule.save(original.copy(revision = app.echoSchedule.state.value.schedule.revision)) } }
            }
        }
    }
}
