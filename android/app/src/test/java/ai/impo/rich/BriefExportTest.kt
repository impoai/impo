package ai.impo.rich

import ai.impo.ui.StreamingPng
import ai.impo.ui.paginateBriefRows
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.util.zip.CRC32
import java.util.zip.InflaterInputStream

class BriefExportTest {
    @Test fun longCardsPaginateWithoutDroppingOrDuplicatingAnyLines() {
        val heights = List(3_007) { if (it % 47 == 0) 40f else 21f }
        val pages = paginateBriefRows(heights, 670f)
        assertEquals(heights.indices.toList(), pages.flatMap { it.toList() })
        assertTrue(pages.all { page -> page.sumOf { heights[it].toDouble() } <= 670 })
        assertTrue(pages.size > 90)
    }

    @Test fun aHeadingStaysWithItsFirstBodyLineAcrossPageBoundary() {
        val pages = paginateBriefRows(listOf(60f, 25f, 20f, 20f), 100f, setOf(1))
        assertEquals(listOf(0..0, 1..3), pages)
        assertEquals(listOf(0..1), paginateBriefRows(listOf(50f, 50f), 100f))
        assertTrue(paginateBriefRows(emptyList(), 100f).isEmpty())
        assertThrows(IllegalArgumentException::class.java) { paginateBriefRows(listOf(101f), 100f) }
        assertThrows(IllegalArgumentException::class.java) { paginateBriefRows(listOf(Float.NaN), 100f) }
    }

    @Test fun pngPreservesAllRowsAlphaDimensionsAndValidChunkChecksums() {
        val bytes = ByteArrayOutputStream()
        StreamingPng(bytes, 2, 3).use { png -> repeat(3) { row -> png.row(intArrayOf(0xff123400.toInt() + row, 0x801234ff.toInt() - row)) } }
        val input = DataInputStream(ByteArrayInputStream(bytes.toByteArray()))
        assertArrayEquals(byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10), ByteArray(8).also(input::readFully))
        val compressed = ByteArrayOutputStream(); var sawEnd = false
        while (input.available() > 0) {
            val length = input.readInt(); val name = ByteArray(4).also(input::readFully); val data = ByteArray(length).also(input::readFully)
            assertEquals(CRC32().apply { update(name); update(data) }.value.toInt(), input.readInt())
            when (String(name, Charsets.US_ASCII)) {
                "IHDR" -> { val header = DataInputStream(ByteArrayInputStream(data)); assertEquals(2, header.readInt()); assertEquals(3, header.readInt()) }
                "IDAT" -> compressed.write(data)
                "IEND" -> sawEnd = true
            }
        }
        assertTrue(sawEnd)
        val decoded = InflaterInputStream(ByteArrayInputStream(compressed.toByteArray())).readBytes()
        assertEquals(27, decoded.size)
        for (row in 0..2) {
            assertEquals(0, decoded[row * 9].toInt())
            assertArrayEquals(byteArrayOf(0x12, 0x34, row.toByte(), 0xff.toByte(), 0x12, 0x34, (0xff - row).toByte(), 0x80.toByte()), decoded.copyOfRange(row * 9 + 1, row * 9 + 9))
        }
    }

    @Test fun incompleteImageFailsInsteadOfSilentlyExportingCroppedContent() {
        val png = StreamingPng(ByteArrayOutputStream(), 1, 2)
        png.row(intArrayOf(0))
        assertThrows(IllegalStateException::class.java) { png.close() }
    }
}
