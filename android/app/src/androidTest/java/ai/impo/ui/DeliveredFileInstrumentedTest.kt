package ai.impo.ui

import ai.impo.client.DeliveredFile
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.pdf.PdfDocument
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DeliveredFileInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun tappingDeliveredPdfGrantsReadAccessToAnIntactDocument() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val stored = File(context.cacheDir, "delivered/instrumented/Impo test.pdf")
        stored.parentFile!!.mkdirs()
        val document = PdfDocument()
        try {
            val page = document.startPage(PdfDocument.PageInfo.Builder(300, 300, 1).create())
            page.canvas.drawText("Impo file download verified", 20f, 40f, android.graphics.Paint())
            document.finishPage(page)
            stored.outputStream().use { document.writeTo(it) }
        } finally { document.close() }
        val opened = AtomicReference<Intent?>()
        val viewer = object : ContextWrapper(context) {
            override fun startActivity(intent: Intent) { opened.set(intent) }
        }
        try {
            val file = DeliveredFile("instrumented-file", stored.name, "application/pdf", stored.length())
            compose.setContent { CompositionLocalProvider(LocalContext provides viewer) {
                ImpoTheme { DeliveredFiles(listOf(file)) { stored } }
            } }
            compose.onNodeWithTag("message.file").performClick()
            compose.waitUntil(5_000) { opened.get() != null }
            val intent = opened.get()!!
            assertEquals(Intent.ACTION_VIEW, intent.action)
            assertEquals("application/pdf", intent.type)
            assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
            val uri: Uri = intent.data!!
            assertEquals("content", uri.scheme)
            assertEquals("${context.packageName}.files", uri.authority)
            context.contentResolver.openFileDescriptor(uri, "r")!!.use { descriptor ->
                PdfRenderer(descriptor).use { assertEquals(1, it.pageCount) }
            }
        } finally { stored.delete() }
    }
}
