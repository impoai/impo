package ai.impo.ui

import android.content.ClipboardManager
import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfRenderer
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import ai.impo.client.Brief
import ai.impo.client.BriefCard
import ai.impo.client.BriefContent
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RichResponseInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val device get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    @Test fun nativeWordSelectionCopiesItsSnapshotWhileTheStreamAdvances() {
        val source = mutableStateOf("Unchanged")
        var selecting = false
        compose.setContent {
            ImpoTheme {
                // Match the app's safe-area + scrolling constraints. A bare one-line
                // response at y=0 is hidden by Android 15's edge-to-edge status bar.
                Column(Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState())) {
                    RichResponse(source.value, streaming = true, onSelectionChanged = { selecting = it })
                }
            }
        }
        // Compose owns the first render; synchronize it before querying Android's
        // accessibility tree. Markwon may retain a paragraph terminator in TextView.
        compose.waitForIdle()
        val text = checkNotNull(device.wait(Until.findObject(By.clazz(android.widget.TextView::class.java).textContains("Unchanged")), 5_000)) {
            "Native response TextView was not exposed after composition: " +
                device.findObjects(By.clazz(android.widget.TextView::class.java)).joinToString { it.text.orEmpty() }
        }
        assertEquals("Unchanged", text.text.trim())
        text.longClick()
        compose.waitUntil(5_000) { selecting }
        compose.runOnIdle { source.value = "Unchanged with later streamed words" }
        assertFalse(device.hasObject(By.textContains("later streamed words")))
        val copy = checkNotNull(device.wait(Until.findObject(By.text(java.util.regex.Pattern.compile("copy", java.util.regex.Pattern.CASE_INSENSITIVE))), 5_000)) { "Android's native selection toolbar should expose Copy" }
        copy.click()
        compose.runOnIdle {
            val clipboard = InstrumentationRegistry.getInstrumentation().targetContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            assertEquals("Unchanged", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        }
        compose.waitUntil(5_000) { !selecting }
        assertTrue(device.wait(Until.hasObject(By.textContains("later streamed words")), 5_000))
    }

    @Test fun fullResponseSelectionIsNativeAndFrozenWhileStreamingThenResumes() {
        val initial = "First paragraph is ready for selection."
        val source = mutableStateOf(initial)
        var selecting = false
        compose.setContent { ImpoTheme { Column(Modifier.verticalScroll(rememberScrollState())) { RichResponse(source.value, streaming = true, onSelectionChanged = { selecting = it }) } } }
        compose.onNodeWithText("Select text").performClick()
        compose.runOnIdle { assertTrue(selecting); source.value = "$initial\n\nSecond paragraph arrived while selecting." }
        assertTrue(device.wait(Until.hasObject(By.text(initial)), 5_000))
        assertFalse(device.hasObject(By.textContains("Second paragraph arrived")))
        compose.onAllNodesWithText("Copy all").onLast().performClick()
        compose.runOnIdle {
            val clipboard = InstrumentationRegistry.getInstrumentation().targetContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            assertEquals(initial, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        }
        compose.onNodeWithText("Done").performClick()
        compose.runOnIdle { assertFalse(selecting) }
        assertTrue(device.wait(Until.hasObject(By.textContains("Second paragraph arrived")), 5_000))
    }

    @Test fun markdownTableAndOfflineMathRenderWithoutCrashingAndKeepReadableCopy() {
        val source = "## Native mathematics\n\nA price of $5, 中文 👋, and ${'$'}x^2${'$'}.\n\n\\[\\frac{a+b}{c}\\]\n\n| Plan | Time |\n| --- | --- |\n| Focus | 25 minutes |\n\n```kotlin\nval greeting = \"Hello Android\"\n```"
        compose.setContent { ImpoTheme { Column(Modifier.verticalScroll(rememberScrollState())) { RichResponse(source) } } }
        compose.waitForIdle()
        assertTrue(device.wait(Until.hasObject(By.textContains("Native mathematics")), 10_000))
        compose.onNodeWithText("Copy all").performScrollTo().performClick()
        compose.runOnIdle {
            val clipboard = InstrumentationRegistry.getInstrumentation().targetContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val copied = clipboard.primaryClip?.getItemAt(0)?.text?.toString().orEmpty()
            assertTrue(copied.contains("中文 👋")); assertTrue(copied.contains("Plan\tTime")); assertTrue(copied.contains("\\frac{a+b}{c}")); assertTrue(copied.contains("val greeting"))
        }
    }

    @Test fun longBriefExportsCompleteMultiPagePdfAndTallPngThroughFileProvider() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val body = List(80) { "Line ${it + 1}: a quiet moment, 中文, and a useful next step with room to breathe." }.joinToString("\n")
        val brief = Brief(id = "export-test", localDate = "2026-09-30", timeZone = "Asia/Shanghai", kind = "morning", label = "Morning Brief", scheduledAt = "2026-09-30T08:00:00Z", createdAt = "2026-09-30T08:00:00Z", status = "completed", content = BriefContent("Room for a good day", "A long edition should retain every line.", listOf(BriefCard("focus", "YOUR FOCUS", "A complete, unhurried plan", body))))
        val pdf = exportBrief(context, brief, true)
        assertEquals("content", pdf.scheme)
        val pages = context.contentResolver.openFileDescriptor(pdf, "r")!!.use { file -> PdfRenderer(file).use { renderer -> renderer.pageCount } }
        assertTrue(pages >= 3)
        val png = exportBrief(context, brief, false)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(png)!!.use { BitmapFactory.decodeStream(it, null, bounds) }
        assertEquals(1190, bounds.outWidth)
        assertEquals(pages * 1684, bounds.outHeight)
        assertEquals("image/png", bounds.outMimeType)
    }
}
