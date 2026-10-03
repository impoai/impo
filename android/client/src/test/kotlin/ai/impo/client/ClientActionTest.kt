package ai.impo.client

import org.junit.Assert.*
import kotlinx.serialization.json.*
import java.net.URI
import java.net.URLDecoder
import org.junit.Test

class ClientActionTest {
    private fun output(name: String = "impo_open_link", args: JsonObject = buildJsonObject { put("url", "https://youtu.be/example") }) = buildJsonObject {
        put("kind", "client_action"); put("schemaVersion", 1); put("actionId", "2b30cd6c-2d20-4f3c-8e98-464974947025")
        put("capability", name); put("execution", "device"); put("interaction", "tap"); put("status", "ready"); put("parameters", args)
    }
    @Test fun nativeTargetsRejectCommandsAndEncodeDestination() {
        listOf("javascript:alert(1)", "file:///etc/passwd", "shortcuts://run-shortcut", "https://user:secret@example.com", "https://example.com\\@evil.test").forEach { url ->
            assertNull(ClientAction.from("impo_open_link", output(args = buildJsonObject { put("url", url) })))
        }
        val action = requireNotNull(ClientAction.from("impo_navigate", output("impo_navigate", buildJsonObject {
            put("destination", "Main St & mode=driving"); put("mode", "walking")
        })))
        val target = URI(action.targetUrl)
        assertEquals("www.google.com", target.host)
        assertEquals(listOf("api=1", "destination=Main St & mode=driving", "travelmode=walking"), target.rawQuery.split('&').map { URLDecoder.decode(it, "UTF-8") })
        assertNull(ClientAction.from("impo_navigate", output()))
        assertFalse(requireNotNull(ClientAction.from("impo_open_link", output(args = buildJsonObject { put("url", "https://youtube.com.evil.test/") }))).isVideo)
    }
    @Test fun onlyCompletedKnownToolResultsBecomeReplayableCards() {
        val reducer = UIMessageReducer()
        reducer.consume("""{"type":"start","messageId":"message"}""")
        reducer.consume("""{"type":"tool-input-available","toolCallId":"call-1","toolName":"impo_open_link","input":{"url":"https://youtu.be/example"}}""")
        assertNull(ClientAction.from(reducer.state.tools.single().name, reducer.state.tools.single().output))
        reducer.consume(buildJsonObject { put("type", "tool-output-available"); put("toolCallId", "call-1"); put("output", output()) }.toString())
        val part = reducer.state.tools.single().part()
        val history = ConversationMessage("message", "assistant", 1, "", "completed", "2026-10-03T00:00:00Z", listOf(part, part))
        assertEquals(1, history.actions.size)
        assertEquals("Open video", history.actions.single().title)
        assertTrue(reducer.state.deviceRequests.isEmpty())
        assertTrue(history.copy(role = "user").actions.isEmpty())
        assertNull(ClientAction.from("cloud_tool", output()))
    }
}
