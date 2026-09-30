package ai.impo.rich

import ai.impo.ui.ResponseSnapshot
import ai.impo.ui.ResponseBlockKind
import ai.impo.ui.plainResponseText
import ai.impo.ui.protectResponseMath
import ai.impo.ui.responseBlocks
import ai.impo.ui.isSafeResponseLink
import org.junit.Assert.*
import org.junit.Test

class RichResponseTest {
    @Test fun mathSupportsFourDelimitersWithoutEatingCurrencyCodeOrEscapes() {
        val source = "Price $5 and $10. Math ${'$'}x^2${'$'} or \\(a+b\\).\n\\[\\frac{a}{b}\\]\n$$\\sum_i x_i$$\n`${'$'}literal${'$'}` and \\${'$'}cash\n```kotlin\nval price = \"$50\"\n```"
        val parsed = protectResponseMath(source)
        assertEquals(4, parsed.equations.size)
        assertEquals(listOf(false, false, true, true), parsed.equations.values.map { it.display })
        assertTrue(parsed.text.contains("`${'$'}literal${'$'}`"))
        assertTrue(parsed.text.contains("val price = \"$50\""))
        val plain = plainResponseText(source)
        assertTrue(plain.contains("Price $5 and $10"))
        assertTrue(plain.contains("${'$'}literal${'$'}"))
        assertTrue(plain.contains("\\frac{a}{b}"))
    }

    @Test fun incompleteEquationsStayLiteralAndCanFinishWithLaterSnapshots() {
        val source = "First paragraph.\n\n\\[\\frac{a}{"
        val pending = protectResponseMath(source)
        assertFalse(pending.equations.values.single().complete)
        assertEquals(source, pending.restore(pending.text))
        assertEquals(listOf(ResponseBlockKind.MARKDOWN), responseBlocks(source).map { it.kind })
        assertTrue(protectResponseMath(source + "b}\\]").equations.values.single().complete)
        assertEquals(ResponseBlockKind.MATH, responseBlocks(source + "b}\\]").last().kind)
        assertTrue(protectResponseMath("Cost $20. Then ${'$'}x").equations.isEmpty())
    }

    @Test fun fenceRulesKeepMathInCodeAndPreserveDifferentFenceLengths() {
        val source = "~~~~text\n${'$'}${'$'}not math${'$'}${'$'}\n~~~\n\\(still code\\)\n~~~~\n\n\\(real math\\)"
        val math = protectResponseMath(source)
        assertEquals(1, math.equations.size)
        assertEquals("real math", math.equations.values.single().body)
        val blocks = responseBlocks(source)
        assertEquals(ResponseBlockKind.CODE, blocks.first().kind)
        assertTrue(blocks.first().text.contains("~~~\n\\(still code\\)"))
        assertTrue(protectResponseMath("    ${'$'}x${'$'}\n\t\\(x\\)").equations.isEmpty())
        assertEquals(ResponseBlockKind.CODE, responseBlocks("    ${'$'}x${'$'}").single().kind)
    }

    @Test fun parserSeparatesOverflowBlocksWithoutBreakingMarkdownLists() {
        val source = "## Heading\n\n- First\n- **Second**\n\n| Name | Value |\n| --- | ---: |\n| Sum | ${'$'}a+b${'$'} |\n\n```kotlin\nval x = 1\n```\n\n${'$'}${'$'}x^2${'$'}${'$'}\n\nFinal."
        assertEquals(listOf(ResponseBlockKind.MARKDOWN, ResponseBlockKind.TABLE, ResponseBlockKind.CODE, ResponseBlockKind.MATH, ResponseBlockKind.MARKDOWN), responseBlocks(source).map { it.kind })
        assertEquals(2, responseBlocks(source)[1].columns)
        val plain = plainResponseText(source)
        assertTrue(plain.contains("Heading")); assertFalse(plain.contains("##")); assertFalse(plain.contains("**"))
        assertTrue(plain.contains("Name\tValue")); assertTrue(plain.contains("val x = 1"))
        assertTrue(plain.contains("Final."))
    }

    @Test fun selectionRetainsOriginalSnapshotAcrossDeltasCompletionAndReplay() {
        val state = ResponseSnapshot("First paragraph")
        assertEquals("First paragraph", state.begin())
        assertEquals("First paragraph", state.receive("First paragraph\nSecond"))
        assertEquals("First paragraph", state.begin())
        assertEquals("First paragraph", state.receive("Recovered whole response 👋"))
        assertTrue(state.selecting)
        assertEquals("Recovered whole response 👋", state.end())
        assertFalse(state.selecting)
        assertEquals("Recovered whole response 👋", state.begin())
    }

    @Test fun untrustedLinksCannotLaunchPlatformIntentsOrLocalFiles() {
        assertTrue(isSafeResponseLink("https://impo.ai/docs?q=hello"))
        assertTrue(isSafeResponseLink("http://localhost:3011/fixture"))
        listOf("javascript:alert(1)", "file:///sdcard/secret", "intent://app/#Intent;end", "data:text/html,hello", "//impo.ai", "https://", "https://impo.ai/\nmalformed").forEach { assertFalse(it, isSafeResponseLink(it)) }
    }

    @Test fun generatedTokenCannotCollideWithUserText() {
        val value = protectResponseMath("IMPOMATHTOKEN0END ${'$'}x${'$'}")
        assertFalse(value.equations.containsKey("IMPOMATHTOKEN0END"))
        assertEquals("IMPOMATHTOKEN0END ${'$'}x${'$'}", value.restore(value.text))
    }

}
