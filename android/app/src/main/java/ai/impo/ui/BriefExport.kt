package ai.impo.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import android.net.Uri
import android.text.Layout
import android.graphics.text.LineBreaker
import android.text.StaticLayout
import android.text.TextPaint
import androidx.core.content.FileProvider
import ai.impo.client.Brief
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File
import java.io.OutputStream
import java.util.UUID
import java.util.zip.CRC32
import java.util.zip.DeflaterOutputStream
import kotlin.coroutines.coroutineContext

/** Consecutive row ranges. Every measured line appears exactly once, including very long cards. */
internal fun paginateBriefRows(heights: List<Float>, pageHeight: Float, keepWithNext: Set<Int> = emptySet()): List<IntRange> {
    require(pageHeight.isFinite() && pageHeight > 0)
    require(heights.all { it.isFinite() && it > 0 && it <= pageHeight }) { "A line exceeds the page height" }
    if (heights.isEmpty()) return emptyList()
    val pages = mutableListOf<IntRange>()
    var start = 0
    var used = 0f
    for (index in heights.indices) {
        var needed = heights[index]
        var tail = index
        while (tail in keepWithNext && tail + 1 < heights.size) { tail++; needed += heights[tail] }
        val required = if (needed <= pageHeight) needed else heights[index]
        if (used > 0 && used + required > pageHeight) { pages += start until index; start = index; used = 0f }
        used += heights[index]
    }
    pages += start..heights.lastIndex
    return pages
}

private const val pageWidth = 595
private const val pageHeight = 842
private const val margin = 48f
private const val contentTop = 110f
private const val contentBottom = 780f
private const val paper = 0xfff4eee3.toInt()
private const val forest = 0xff264d3d.toInt()
private const val ink = 0xff293d2e.toInt()
private const val muted = 0xff6e6e59.toInt()
private val contentWidth = pageWidth - (margin * 2).toInt()
private enum class ExportStyle(val size: Float, val color: Int, val serif: Boolean = false, val bold: Boolean = false) {
    TITLE(33f, forest, true), SUMMARY(17f, muted), EYEBROW(10f, forest, bold = true),
    CARD_TITLE(24f, forest, true), BODY(15f, ink), SOURCE(11f, muted),
}
private data class ExportRow(val layout: StaticLayout, val line: Int, val gap: Float, val height: Float, val keepNext: Boolean)

/** PDF is paginated; PNG streams those complete pages vertically without allocating a tall bitmap. */
@android.annotation.SuppressLint("InlinedApi") // BREAK_STRATEGY_HIGH_QUALITY is the same inlined value on API 28.
suspend fun exportBrief(context: Context, brief: Brief, pdf: Boolean): Uri = withContext(Dispatchers.Default) {
    val content = requireNotNull(brief.visibleContent) { "Only a completed, current Brief can be exported" }
    val rows = mutableListOf<ExportRow>()
    fun add(text: String, style: ExportStyle, gap: Float = 0f, keepNext: Boolean = false) {
        if (text.isBlank()) return
        val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            textSize = style.size
            color = style.color
            typeface = Typeface.create(if (style.serif) "serif" else "sans-serif", if (style.bold) Typeface.BOLD else Typeface.NORMAL)
        }
        val layout = StaticLayout.Builder.obtain(text, 0, text.length, paint, contentWidth)
            .setIncludePad(false).setLineSpacing(5f, 1f)
            .setBreakStrategy(LineBreaker.BREAK_STRATEGY_HIGH_QUALITY)
            .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NORMAL).build()
        for (line in 0 until layout.lineCount) {
            val before = if (line == 0) gap else 0f
            rows += ExportRow(layout, line, before, layout.getLineBottom(line) - layout.getLineTop(line) + before, keepNext || (style == ExportStyle.TITLE || style == ExportStyle.CARD_TITLE) && line + 1 < layout.lineCount)
        }
    }
    add(content.title, ExportStyle.TITLE, keepNext = true)
    add(content.summary, ExportStyle.SUMMARY, 14f)
    content.cards.forEach { card ->
        add(card.eyebrow.uppercase(), ExportStyle.EYEBROW, 28f, keepNext = true)
        add(card.title, ExportStyle.CARD_TITLE, 7f, keepNext = true)
        add(plainResponseText(card.body), ExportStyle.BODY, 12f)
        card.bullets.forEach { add("• ${plainResponseText(it)}", ExportStyle.BODY, 7f) }
        card.links.forEach { add("${it.title}\n${it.url}", ExportStyle.SOURCE, 9f) }
        val sources = brief.sources.filter { it.id in card.sourceIds }
        if (sources.isNotEmpty()) add("From ${sources.joinToString(" · ") { it.title }}", ExportStyle.SOURCE, 10f)
    }
    if (brief.sources.isNotEmpty()) {
        add("SOURCES", ExportStyle.EYEBROW, 30f, keepNext = true)
        brief.sources.forEach { source -> add("${source.title} · ${source.occurredLocalDate ?: source.occurredAt.take(10)}", ExportStyle.SOURCE, 7f) }
    }
    if (brief.inputTruncated) add("This edition was prepared from a limited selection of your available context.", ExportStyle.SOURCE, 18f)
    val pages = paginateBriefRows(rows.map { it.height }, contentBottom - contentTop, rows.indices.filterTo(mutableSetOf()) { rows[it].keepNext })
    require(pages.isNotEmpty()) { "The Brief has no exportable content" }
    fun draw(canvas: Canvas, page: Int) {
        canvas.drawColor(paper)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = forest; textSize = 28f; typeface = Typeface.create("serif", Typeface.NORMAL) }
        canvas.drawText("impo", margin, 48f, paint)
        paint.textSize = 10f; paint.typeface = Typeface.create("sans-serif", Typeface.BOLD)
        canvas.drawText("BRIEF", pageWidth - margin - paint.measureText("BRIEF"), 44f, paint)
        paint.color = 0xffd4c7ab.toInt(); paint.strokeWidth = 1f
        canvas.drawLine(margin, 66f, pageWidth - margin, 66f, paint)
        paint.color = muted; paint.textSize = 10f; paint.typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        canvas.drawText("${brief.localDate}  ·  ${brief.label}", margin, 87f, paint)
        var y = contentTop
        for (index in pages[page]) {
            val row = rows[index]
            canvas.save()
            canvas.clipRect(margin, y + row.gap, pageWidth - margin, y + row.height)
            canvas.translate(margin, y + row.gap - row.layout.getLineTop(row.line))
            row.layout.draw(canvas)
            canvas.restore()
            y += row.height
        }
        paint.color = 0xffd4c7ab.toInt(); canvas.drawLine(margin, 800f, pageWidth - margin, 800f, paint)
        paint.color = muted; paint.textSize = 9f
        canvas.drawText("Made with Impo · ${brief.timeZone}", margin, 818f, paint)
        val count = "${page + 1} / ${pages.size}"
        canvas.drawText(count, pageWidth - margin - paint.measureText(count), 818f, paint)
    }
    val directory = File(context.cacheDir, "shared").apply { check(isDirectory || mkdirs()) { "Cannot prepare shared export directory" } }
    val file = File(directory, "impo-brief-${brief.localDate}-${UUID.randomUUID()}.${if (pdf) "pdf" else "png"}")
    try {
        if (pdf) {
            val document = PdfDocument()
            try {
                pages.indices.forEach { index ->
                    coroutineContext.ensureActive()
                    val page = document.startPage(PdfDocument.PageInfo.Builder(pageWidth, pageHeight, index + 1).create())
                    draw(page.canvas, index); document.finishPage(page)
                }
                file.outputStream().buffered().use(document::writeTo)
            } finally { document.close() }
        } else {
            val scale = 2
            val width = pageWidth * scale
            val height = Math.multiplyExact(pageHeight * scale, pages.size)
            file.outputStream().buffered().use { output ->
                StreamingPng(output, width, height).use { png ->
                    pages.indices.forEach { index ->
                        coroutineContext.ensureActive()
                        val bitmap = Bitmap.createBitmap(width, pageHeight * scale, Bitmap.Config.ARGB_8888)
                        try {
                            val canvas = Canvas(bitmap); canvas.scale(scale.toFloat(), scale.toFloat()); draw(canvas, index)
                            val pixels = IntArray(width)
                            for (line in 0 until bitmap.height) { bitmap.getPixels(pixels, 0, width, 0, line, width, 1); png.row(pixels) }
                        } finally { bitmap.recycle() }
                    }
                }
            }
        }
        FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    } catch (failure: Throwable) { file.delete(); throw failure }
}

/** PNG rows go directly through zlib into bounded IDAT chunks; memory is one page plus one row. */
internal class StreamingPng(private val output: OutputStream, private val width: Int, private val height: Int) : AutoCloseable {
    private var rows = 0
    private var closed = false
    private val pending = ByteArrayOutputStream(32 * 1024)
    private val compressed: DeflaterOutputStream
    init {
        require(width > 0 && height > 0)
        output.write(byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10))
        val header = ByteArrayOutputStream()
        DataOutputStream(header).apply { writeInt(width); writeInt(height); writeByte(8); writeByte(6); writeByte(0); writeByte(0); writeByte(0) }
        chunk("IHDR", header.toByteArray())
        compressed = DeflaterOutputStream(object : OutputStream() {
            override fun write(value: Int) { pending.write(value); if (pending.size() >= 32 * 1024) flushIdat() }
            override fun write(bytes: ByteArray, offset: Int, length: Int) {
                var cursor = offset; var remaining = length
                while (remaining > 0) { val count = minOf(remaining, 32 * 1024 - pending.size()); pending.write(bytes, cursor, count); cursor += count; remaining -= count; if (pending.size() >= 32 * 1024) flushIdat() }
            }
        })
    }
    fun row(argb: IntArray) {
        check(!closed && rows < height); require(argb.size == width)
        val bytes = ByteArray(width * 4 + 1) // Filter 0: each row stands alone.
        argb.forEachIndexed { index, pixel -> val offset = index * 4 + 1; bytes[offset] = (pixel ushr 16).toByte(); bytes[offset + 1] = (pixel ushr 8).toByte(); bytes[offset + 2] = pixel.toByte(); bytes[offset + 3] = (pixel ushr 24).toByte() }
        compressed.write(bytes); rows++
    }
    private fun chunk(type: String, bytes: ByteArray) {
        val name = type.toByteArray(Charsets.US_ASCII)
        val crc = CRC32().apply { update(name); update(bytes) }
        DataOutputStream(output).apply { writeInt(bytes.size); write(name); write(bytes); writeInt(crc.value.toInt()) }
    }
    private fun flushIdat() { if (pending.size() > 0) { chunk("IDAT", pending.toByteArray()); pending.reset() } }
    override fun close() {
        if (closed) return
        compressed.finish(); compressed.close(); flushIdat(); closed = true
        check(rows == height) { "PNG is missing rows" }
        chunk("IEND", byteArrayOf())
    }
}
