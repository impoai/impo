package ai.impo.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import io.noties.markwon.MarkwonConfiguration
import io.noties.markwon.LinkResolver
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.text.TextPaint
import android.graphics.Typeface
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.ViewGroup
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.Markwon
import io.noties.markwon.core.MarkwonTheme
import io.noties.markwon.ext.latex.JLatexMathPlugin
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin
import io.noties.markwon.inlineparser.MarkwonInlineParserPlugin
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.node.*
import org.commonmark.node.Text as MarkdownText
import org.commonmark.parser.Parser
import kotlin.math.ceil
import kotlin.math.max

private val responseForest = 0xff264d3d.toInt()
private val responseInk = 0xff293d2e.toInt()
private val responsePaper = 0xfffcf8ee.toInt()

/** A selection owns a frozen snapshot even if a stream finishes or replaces its text. */
internal class ResponseSnapshot(initial: String = "") {
    private var latest = initial
    private var held: String? = null
    val displayed: String get() = held ?: latest
    val selecting: Boolean get() = held != null
    fun receive(value: String): String { latest = value; return displayed }
    fun begin(): String { if (held == null) held = latest; return displayed }
    fun end(): String { held = null; return latest }
}

internal data class MathEquation(val original: String, val body: String, val display: Boolean, val complete: Boolean)
internal data class ProtectedMath(val text: String, val equations: Map<String, MathEquation>) {
    fun restore(value: String): String = equations.entries.fold(value) { result, (token, equation) -> result.replace(token, equation.original) }
    fun markdown(value: String): String = equations.entries.fold(value) { result, (token, equation) ->
        result.replace(token, when {
            !equation.complete -> equation.original.replace("\\", "\\\\").replace("$", "\\$")
            equation.display -> "\n\n$$\n${equation.body}\n$$\n\n"
            else -> "$$${equation.body}$$"
        })
    }
}

/** Recognize math before CommonMark. Code, currency and unfinished equations remain literal. */
internal fun protectResponseMath(source: String): ProtectedMath {
    var prefix = "IMPOMATHTOKEN"
    while (source.contains(prefix)) prefix += "X"
    val equations = linkedMapOf<String, MathEquation>()
    val output = StringBuilder()
    var i = 0
    var fence: Pair<Char, Int>? = null
    fun escaped(index: Int): Boolean { var cursor = index - 1; var count = 0; while (cursor >= 0 && source[cursor] == '\\') { count++; cursor-- }; return count % 2 == 1 }
    fun matches(value: String, index: Int) = source.startsWith(value, index)
    while (i < source.length) {
        if (i == 0 || source[i - 1] == '\n') {
            val end = source.indexOf('\n', i).takeIf { it >= 0 } ?: source.length
            val line = source.substring(i, end)
            val spaces = line.takeWhile { it == ' ' }.length
            val trimmed = line.drop(spaces)
            val first = trimmed.firstOrNull()
            val run = trimmed.takeWhile { it == first }.length
            if (spaces <= 3 && first in listOf('`', '~') && run >= 3) {
                if (fence == null) fence = first!! to run
                else if (first == fence!!.first && run >= fence!!.second && trimmed.drop(run).isBlank()) fence = null
                output.append(line); i = end
                if (i < source.length) { output.append('\n'); i++ }
                continue
            }
            if (fence != null || spaces >= 4 || line.startsWith('\t')) {
                output.append(line); i = end
                if (i < source.length) { output.append('\n'); i++ }
                continue
            }
        }
        if (source[i] == '`' && !escaped(i)) {
            val count = source.substring(i).takeWhile { it == '`' }.length
            var end = i + count
            while (end < source.length) {
                if (source[end] == '`') {
                    val closing = source.substring(end).takeWhile { it == '`' }.length
                    end += closing
                    if (closing == count) break
                } else end++
            }
            output.append(source.substring(i, end)); i = end; continue
        }
        var consumed = false
        for ((open, close, display) in listOf(Triple("\\[", "\\]", true), Triple("\\(", "\\)", false), Triple("$$", "$$", true), Triple("$", "$", false))) {
            if (!matches(open, i) || escaped(i)) continue
            val start = i + open.length
            if (start >= source.length) continue
            if (open == "$" && (source[start].isWhitespace() || source[start] == '$')) continue
            var end = start
            while (end < source.length) {
                if (!display && (source[end] == '\n' || source[end] == '`')) break
                if (matches(close, end) && !escaped(end)) {
                    if (end == start || (open == "$" && (source[end - 1].isWhitespace() || source.getOrNull(end + 1)?.isDigit() == true))) break
                    val token = "${prefix}${equations.size}END"
                    equations[token] = MathEquation(source.substring(i, end + close.length), source.substring(start, end), display, true)
                    output.append(token); i = end + close.length; consumed = true; break
                }
                end++
            }
            if (!consumed && open != "$") {
                val token = "${prefix}${equations.size}END"
                equations[token] = MathEquation(source.substring(i, end), source.substring(start, end), display, false)
                output.append(token); i = end; consumed = true
            }
            if (consumed) break
        }
        if (!consumed) {
            // Markwon's math extension uses $$ for inline math; escape only literal dollars.
            if (source[i] == '$' && !escaped(i)) output.append('\\')
            output.append(source[i]); i++
        }
    }
    return ProtectedMath(output.toString(), equations)
}

internal fun isSafeResponseLink(link: String): Boolean = runCatching {
    val uri = java.net.URI(link)
    uri.scheme?.lowercase() in setOf("https", "http") && !uri.host.isNullOrBlank()
}.getOrDefault(false)

internal enum class ResponseBlockKind { MARKDOWN, CODE, TABLE, MATH }
internal data class ResponseBlock(val kind: ResponseBlockKind, val text: String, val language: String = "", val columns: Int = 1)
private fun tableCells(line: String) = line.trim().removePrefix("|").removeSuffix("|").split(Regex("(?<!\\\\)\\|"))
internal fun responseBlocks(source: String): List<ResponseBlock> {
    val protected = protectResponseMath(source)
    val result = mutableListOf<ResponseBlock>()
    fun markdownBlocks(value: String) {
        val lines = value.split('\n'); val prose = mutableListOf<String>(); var index = 0
        fun flush() { if (prose.any { it.isNotBlank() }) result += ResponseBlock(ResponseBlockKind.MARKDOWN, protected.markdown(prose.joinToString("\n"))); prose.clear() }
        while (index < lines.size) {
            val match = Regex("^ {0,3}(`{3,}|~{3,})(.*)$").find(lines[index])
            if (match != null) {
                flush(); val marker = match.groupValues[1]; val body = mutableListOf<String>(); index++
                while (index < lines.size && !Regex("^ {0,3}${Regex.escape(marker.first().toString())}{${marker.length},}\\s*$").matches(lines[index])) body += lines[index++]
                if (index < lines.size) index++
                result += ResponseBlock(ResponseBlockKind.CODE, protected.restore(body.joinToString("\n")), match.groupValues[2].trim())
                continue
            }
            if ((lines[index].startsWith("    ") || lines[index].startsWith('\t')) && (index == 0 || lines[index - 1].isBlank())) {
                flush(); val body = mutableListOf<String>()
                while (index < lines.size && (lines[index].startsWith("    ") || lines[index].startsWith('\t') || lines[index].isBlank())) {
                    body += lines[index].removePrefix("    ").removePrefix("\t"); index++
                }
                result += ResponseBlock(ResponseBlockKind.CODE, protected.restore(body.joinToString("\n").trimEnd('\n')))
                continue
            }
            if (index + 1 < lines.size && lines[index].contains('|') && tableCells(lines[index + 1]).all { Regex(":?-{3,}:?").matches(it.trim()) }) {
                flush(); val table = mutableListOf(lines[index], lines[index + 1]); val columns = tableCells(lines[index]).size; index += 2
                while (index < lines.size && lines[index].contains('|') && lines[index].isNotBlank()) table += lines[index++]
                result += ResponseBlock(ResponseBlockKind.TABLE, protected.markdown(table.joinToString("\n")), columns = columns)
                continue
            }
            prose += lines[index++]
        }
        flush()
    }
    var remainder = protected.text
    while (remainder.isNotEmpty()) {
        val next = protected.equations.entries.filter { it.value.display && it.value.complete }.mapNotNull { entry -> remainder.indexOf(entry.key).takeIf { it >= 0 }?.let { Triple(it, entry.key, entry.value) } }.minByOrNull { it.first }
        if (next == null) { markdownBlocks(remainder); break }
        markdownBlocks(remainder.substring(0, next.first))
        result += ResponseBlock(ResponseBlockKind.MATH, "$$\n${next.third.body}\n$$")
        remainder = remainder.substring(next.first + next.second.length)
    }
    return result
}

internal fun plainResponseText(source: String): String {
    val math = protectResponseMath(source)
    val parser = Parser.builder().extensions(listOf(TablesExtension.create(), StrikethroughExtension.create())).build()
    fun read(node: Node): String {
        fun children(): String { val out = StringBuilder(); var child = node.firstChild; while (child != null) { out.append(read(child)); child = child.next }; return out.toString() }
        return when (node) {
            is MarkdownText -> node.literal
            is Code -> node.literal
            is FencedCodeBlock -> node.literal + "\n"
            is IndentedCodeBlock -> node.literal + "\n"
            is SoftLineBreak, is HardLineBreak -> "\n"
            is Heading, is Paragraph -> children() + "\n\n"
            is ThematicBreak -> "—\n\n"
            is ListItem -> "• ${children().trim()}\n"
            is HtmlInline -> node.literal
            is HtmlBlock -> node.literal + "\n"
            else -> when (node.javaClass.simpleName) { "TableCell" -> children() + "\t"; "TableRow" -> children().trimEnd('\t') + "\n"; else -> children() }
        }
    }
    return math.restore(read(parser.parse(math.text))).trim()
}

@Composable
fun RichResponse(text: String, modifier: Modifier = Modifier, streaming: Boolean = false, onSelectionChanged: (Boolean) -> Unit = {}, showActions: Boolean = true) {
    val context = LocalContext.current
    val snapshot = remember { ResponseSnapshot(text) }
    var selectionVersion by remember { mutableIntStateOf(0) }
    var fullSelection by remember { mutableStateOf<String?>(null) }
    // Observe selection changes in composition, not just AndroidView.update:
    // ending native selection must derive the latest queued stream snapshot.
    val displayed = remember(text, selectionVersion) { snapshot.receive(text) }
    val selectionListener by rememberUpdatedState(onSelectionChanged)
    DisposableEffect(Unit) { onDispose { selectionListener(false) } }
    fun finishSelection() { fullSelection = null; snapshot.end(); selectionVersion++; selectionListener(false) }
    fun copy(value: String) { (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Impo response", plainResponseText(value))) }
    Column(modifier) {
        AndroidView(
            factory = { ResponseNativeView(it) },
            update = { view ->
                view.selectionChanged = { active ->
                    if (active) snapshot.begin() else snapshot.end()
                    selectionVersion++
                    selectionListener(active)
                }
                view.render(displayed)
            },
            modifier = Modifier.fillMaxWidth(),
        )
        if (showActions) Row(Modifier.fillMaxWidth()) {
            TextButton(onClick = { copy(snapshot.displayed) }) { Text("Copy all") }
            TextButton(onClick = { fullSelection = plainResponseText(snapshot.begin()); selectionListener(true) }) { Text("Select text") }
            if (streaming && snapshot.selecting) Text("Selection paused", modifier = Modifier.padding(12.dp))
        }
    }
    fullSelection?.let { frozen ->
        Dialog(onDismissRequest = { finishSelection() }) {
            Surface(color = Color(responsePaper), shape = androidx.compose.foundation.shape.RoundedCornerShape(20.dp)) {
                Column(Modifier.fillMaxWidth().fillMaxHeight(0.86f).padding(16.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        TextButton(onClick = { (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Impo response", frozen)) }) { Text("Copy all") }
                        TextButton(onClick = { finishSelection() }) { Text("Done") }
                    }
                    AndroidView(factory = { ctx -> ScrollView(ctx).apply { addView(TextView(ctx).apply { this.text = frozen; textSize = 17f; setTextColor(responseInk); setTextIsSelectable(true); setPadding(8, 12, 8, 24); setLineSpacing(5f, 1f) }) } }, modifier = Modifier.fillMaxWidth().weight(1f))
                }
            }
        }
    }
}

private class ResponseNativeView(context: Context) : LinearLayout(context) {
    var selectionChanged: (Boolean) -> Unit = {}
    private var rendered: String? = null
    private val density = resources.displayMetrics.density
    private val fontScale = resources.configuration.fontScale
    private val renderer = Markwon.builder(context)
        .usePlugin(TablePlugin.create(context))
        .usePlugin(StrikethroughPlugin.create())
        .usePlugin(MarkwonInlineParserPlugin.create())
        .usePlugin(JLatexMathPlugin.create(17f * density * fontScale) { builder -> builder.inlinesEnabled(true); builder.errorHandler { latex, _ -> FormulaFallback(latex, 17f * density * fontScale) }; builder.theme().textColor(responseInk).blockFitCanvas(false) })
        .usePlugin(object : AbstractMarkwonPlugin() {
            override fun configureConfiguration(builder: MarkwonConfiguration.Builder) {
                builder.linkResolver(object : LinkResolver {
                    override fun resolve(view: View, link: String) {
                        val uri = Uri.parse(link)
                        if (!isSafeResponseLink(link)) return
                        runCatching { view.context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    }
                })
            }
            override fun configureTheme(builder: MarkwonTheme.Builder) {
                builder.linkColor(responseForest).headingTypeface(Typeface.create("serif", Typeface.NORMAL))
                    .headingTextSizeMultipliers(floatArrayOf(1.6f, 1.35f, 1.17f, 1.05f, 1f, 1f))
                    .codeBackgroundColor(0xffeaece3.toInt()).codeBlockBackgroundColor(0xffeaece3.toInt())
                    .blockQuoteColor(0xff73927c.toInt())
            }
        }).build()
    init { orientation = VERTICAL; layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT) }
    fun render(source: String) {
        if (rendered == source) return
        rendered = source
        removeAllViews()
        responseBlocks(source).forEach { block ->
            val view = TextView(context).apply {
                textSize = 17f; setTextColor(responseInk); setLinkTextColor(responseForest)
                setLineSpacing(4f * density, 1f); includeFontPadding = false
                setTextIsSelectable(true)
                customSelectionActionModeCallback = object : ActionMode.Callback {
                    override fun onCreateActionMode(mode: ActionMode?, menu: Menu?): Boolean { selectionChanged(true); return true }
                    override fun onPrepareActionMode(mode: ActionMode?, menu: Menu?) = false
                    override fun onActionItemClicked(mode: ActionMode?, item: MenuItem?) = false
                    override fun onDestroyActionMode(mode: ActionMode?) { selectionChanged(false) }
                }
                setPadding(0, (4 * density).toInt(), 0, (10 * density).toInt())
            }
            if (block.kind == ResponseBlockKind.CODE) {
                view.typeface = Typeface.MONOSPACE; view.textSize = 14f; view.text = block.text
                view.setBackgroundColor(0xffeaece3.toInt()); view.setPadding((12 * density).toInt(), (12 * density).toInt(), (12 * density).toInt(), (12 * density).toInt())
            } else runCatching { renderer.setMarkdown(view, block.text) }.onFailure { view.text = block.text }
            if (block.kind == ResponseBlockKind.MARKDOWN) addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
            else {
                val scroll = HorizontalScrollView(context).apply { isFillViewport = true; isHorizontalScrollBarEnabled = true }
                if (block.kind == ResponseBlockKind.TABLE) view.minWidth = (max(2, block.columns) * 150 * density).toInt()
                if (block.kind == ResponseBlockKind.CODE) {
                    view.setHorizontallyScrolling(true)
                    view.minWidth = ceil(block.text.lines().maxOfOrNull { view.paint.measureText(it) } ?: 0f).toInt() + (24 * density).toInt()
                }
                if (block.kind == ResponseBlockKind.MATH) { view.setHorizontallyScrolling(true); view.minWidth = (resources.displayMetrics.widthPixels - 64 * density).toInt() }
                scroll.addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
                addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { bottomMargin = (8 * density).toInt() })
            }
        }
    }
}

/** Unsupported TeX remains readable instead of becoming an empty drawable. */
private class FormulaFallback(private val source: String, size: Float) : Drawable() {
    private val paint = TextPaint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { textSize = size; color = responseInk; typeface = Typeface.MONOSPACE }
    override fun getIntrinsicWidth(): Int = ceil(paint.measureText(source)).toInt().coerceAtLeast(1)
    override fun getIntrinsicHeight(): Int = ceil(paint.fontMetrics.descent - paint.fontMetrics.ascent).toInt().coerceAtLeast(1)
    override fun draw(canvas: Canvas) { canvas.drawText(source, bounds.left.toFloat(), bounds.top - paint.fontMetrics.ascent, paint) }
    override fun setAlpha(alpha: Int) { paint.alpha = alpha }
    override fun setColorFilter(filter: ColorFilter?) { paint.colorFilter = filter }
    @Deprecated("Deprecated in Android") override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
