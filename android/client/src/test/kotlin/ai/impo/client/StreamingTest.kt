package ai.impo.client

import org.junit.Assert.*
import org.junit.Test

class StreamingTest {
    private val chunks = listOf(
        """{"type":"start","messageId":"assistant"}""",
        """{"type":"text-start","id":"text"}""",
        """{"type":"text-delta","id":"text","delta":"Hello 👋 世界 café"}""",
        """{"type":"text-end","id":"text"}""",
        """{"type":"data-instant-submission","data":{"schemaVersion":1,"submissionId":"run","status":"completed"}}""",
        """{"type":"finish"}""", "[DONE]",
    )
    private fun wire(ending: String) = ("\uFEFF: keepalive$ending$ending" + chunks.joinToString("") { "data: $it$ending$ending" }).toByteArray()
    @Test fun unicodeAndDelimitersCanBeSplitAtEveryByte() {
        for (ending in listOf("\n", "\r\n", "\r")) {
            val wire = wire(ending)
            for (split in 0..wire.size) {
                val parser = SseParser(); val reducer = UIMessageReducer()
                (parser.feed(wire.copyOfRange(0, split)) + parser.feed(wire.copyOfRange(split, wire.size))).forEach(reducer::consume)
                parser.validateEOF(); reducer.validateEOF()
                assertEquals("Hello 👋 世界 café", reducer.state.text)
            }
            val parser = SseParser(); val reducer = UIMessageReducer()
            wire.forEach { parser.feed(byteArrayOf(it)).forEach(reducer::consume) }
            parser.validateEOF(); reducer.validateEOF()
        }
    }
    @Test fun multilineDataAndUnrelatedFieldsFollowSseSemantics() {
        val parser = SseParser()
        assertEquals(listOf("one\ntwo", ""), parser.feed("id: 3\nevent: anything\n: ping\ndata: one\ndata:two\n\ndata\n\n".toByteArray()))
        parser.validateEOF()
    }
    @Test fun invalidUtf8IsRejectedInsteadOfReplacementCharacter() {
        expectProtocol { SseParser().feed(byteArrayOf(0xc3.toByte(), 0x28, 10)) }
    }
    @Test fun unterminatedEventAndOversizedEventAreRejected() {
        val parser = SseParser(); parser.feed("data: orphan\n".toByteArray()); expectProtocol { parser.validateEOF() }
        expectProtocol { SseParser(10).feed("data: 123456789\n\n".toByteArray()) }
        expectProtocol { SseParser(10).feed(":12345678901".toByteArray()) }
    }
    @Test fun incompleteStreamsNeverPretendTheRunCompleted() {
        val reducer = UIMessageReducer(); chunks.dropLast(2).forEach(reducer::consume)
        expectProtocol { reducer.validateEOF() }; expectProtocol { reducer.consume("[DONE]") }
        val errorOnly = UIMessageReducer(); errorOnly.consume(chunks.first()); errorOnly.consume("""{"type":"error","errorText":"Disconnected"}""")
        expectProtocol { errorOnly.consume("[DONE]") }
    }
    @Test fun reconnectReconstructsRatherThanAppendingPriorText() {
        val old = UIMessageReducer(); chunks.take(3).forEach(old::consume)
        val fresh = UIMessageReducer(); chunks.forEach(fresh::consume)
        assertEquals(old.state.text, fresh.state.text)
        assertEquals("assistant", fresh.state.messageId)
    }
    @Test fun toolsRequireInputAndOnlyOneResultEvenWhenOutputIsJsonNull() {
        val reducer = UIMessageReducer(); reducer.consume(chunks.first())
        expectProtocol { reducer.consume("""{"type":"tool-output-available","toolCallId":"tool","output":null}""") }
        reducer.consume("""{"type":"tool-input-available","toolCallId":"tool","toolName":"search","input":{}}""")
        reducer.consume("""{"type":"tool-output-available","toolCallId":"tool","output":null}""")
        expectProtocol { reducer.consume("""{"type":"tool-output-error","toolCallId":"tool","errorText":"Again"}""") }
    }
    @Test fun stepUpdatesKeepFirstSeenOrderAndMalformedOptionalStepsAreIgnored() {
        val reducer = UIMessageReducer(); reducer.consume(chunks.first())
        fun step(id: String, status: String) = """{"type":"data-instant-step","id":"$id","data":{"schemaVersion":1,"kind":"search","title":"Search","status":"$status"}}"""
        reducer.consume(step("a", "in_progress")); reducer.consume(step("b", "in_progress")); reducer.consume(step("a", "completed"))
        reducer.consume("""{"type":"data-instant-step","data":false}""")
        reducer.consume("""{"type":"data-future-extension"}""")
        assertEquals(listOf("a", "b"), reducer.state.steps.map { it.id })
        assertEquals("completed", reducer.state.steps.first().status)
    }
    @Test fun duplicateStartsAndOpenTextFinishAndUnknownCoreChunksAreRejected() {
        val reducer = UIMessageReducer(); expectProtocol { reducer.consume(chunks[1]) }
        reducer.consume(chunks[0]); expectProtocol { reducer.consume(chunks[0]) }
        reducer.consume(chunks[1]); expectProtocol { reducer.consume(chunks[5]) }
        expectProtocol { reducer.consume("""{"type":"surprise-core"}""") }
        reducer.consume("""{"type":"abort"}"""); reducer.consume(chunks[5]); reducer.consume("[DONE]")
        expectProtocol { reducer.consume(chunks[2]) }
    }
    @Test fun submissionAndDeviceRequestIdentityCannotChange() {
        val reducer = UIMessageReducer(); reducer.consume(chunks[0]); reducer.consume(chunks[4])
        expectProtocol { reducer.consume(chunks[4].replace("run", "different")) }
        val device = """{"type":"data-instant-device-request","data":{"schemaVersion":1,"invocationId":"i","toolCallId":"t","deviceId":"d","expiresAt":"2026-10-01T00:00:00Z"}}"""
        reducer.consume(device); reducer.consume(device)
        expectProtocol { reducer.consume(device.replace("\"d\"", "\"other\"")) }
        expectProtocol { reducer.consume(device.replace("schemaVersion\":1", "schemaVersion\":2")) }
    }
    private fun expectProtocol(block: () -> Unit) { try { block(); fail("Expected protocol error") } catch (_: ProtocolException) {} }
}
