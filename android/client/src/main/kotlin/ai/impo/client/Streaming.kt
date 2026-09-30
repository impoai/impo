package ai.impo.client

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/** Framing operates on bytes so every UTF-8 boundary and CRLF split is safe. */
class SseParser(private val maximumEventBytes: Int = 1_048_576) {
    private val line = ByteArrayOutputStream()
    private val dataLines = mutableListOf<String>()
    private var dataBytes = 0
    private var skipLF = false
    private var firstLine = true
    fun feed(bytes: ByteArray, count: Int = bytes.size): List<String> {
        require(count in 0..bytes.size)
        val events = mutableListOf<String>()
        for (index in 0 until count) {
            val byte = bytes[index].toInt() and 255
            if (skipLF) { skipLF = false; if (byte == 10) continue }
            if (byte == 10 || byte == 13) {
                skipLF = byte == 13
                endLine()?.let(events::add)
            } else {
                line.write(byte)
                if (line.size() + dataBytes > maximumEventBytes) throw ProtocolException("SSE event exceeds limit")
            }
        }
        return events
    }
    private fun endLine(): String? {
        var bytes = line.toByteArray()
        line.reset()
        if (firstLine) {
            firstLine = false
            if (bytes.size >= 3 && bytes[0] == 0xef.toByte() && bytes[1] == 0xbb.toByte() && bytes[2] == 0xbf.toByte()) bytes = bytes.copyOfRange(3, bytes.size)
        }
        val text = try { Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString() }
            catch (_: java.nio.charset.CharacterCodingException) { throw ProtocolException("Invalid UTF-8 in SSE") }
        if (text.isEmpty()) {
            val event = if (dataLines.isEmpty()) null else dataLines.joinToString("\n")
            dataLines.clear(); dataBytes = 0
            return event
        }
        if (text.startsWith(':')) return null
        if (text.substringBefore(':') != "data") return null
        val value = if (':' in text) text.substringAfter(':').removePrefix(" ") else ""
        dataBytes += value.toByteArray(Charsets.UTF_8).size + 1
        if (dataBytes > maximumEventBytes) throw ProtocolException("SSE event exceeds limit")
        dataLines += value
        return null
    }
    fun validateEOF() {
        if (line.size() != 0 || dataLines.isNotEmpty()) throw ProtocolException("Truncated SSE event")
    }
}
@Serializable data class ToolState(val toolCallId: String, val name: String, val input: JsonElement, val output: JsonElement? = null, val error: String? = null)
@Serializable data class DeviceRequest(val schemaVersion: Int, val invocationId: String, val toolCallId: String, val deviceId: String, val expiresAt: String)
@Serializable data class StreamStep(val id: String, val kind: String, val title: String, val status: String, val detail: String? = null, val result: String? = null)
data class StreamState(
    val messageId: String? = null, val submissionId: String? = null, val status: String? = null,
    val text: String = "", val tools: List<ToolState> = emptyList(), val deviceRequests: List<DeviceRequest> = emptyList(),
    val steps: List<StreamStep> = emptyList(), val errors: List<String> = emptyList(),
    val aborted: Boolean = false, val finished: Boolean = false, val done: Boolean = false,
)
class UIMessageReducer {
    var state = StreamState(); private set
    private val textParts = linkedMapOf<String, String>()
    private val openText = mutableSetOf<String>()
    private val tools = linkedMapOf<String, ToolState>()
    private val requests = linkedMapOf<String, DeviceRequest>()
    private val steps = linkedMapOf<String, StreamStep>()
    fun consume(event: String): StreamState {
        valid(!state.done, "Event after DONE")
        if (event == "[DONE]") {
            valid(state.finished, "Incomplete message stream")
            state = state.copy(done = true); return state
        }
        val chunk = try { ProtocolJson.parseToJsonElement(event).jsonObject } catch (_: Exception) { throw ProtocolException("Invalid stream JSON") }
        val type = chunk.string("type")
        valid(!state.finished, "Chunk after finish")
        valid(type == "start" || state.messageId != null, "Chunk before start")
        when (type) {
            "start" -> { valid(state.messageId == null, "Duplicate start"); state = state.copy(messageId = chunk.string("messageId")) }
            "text-start" -> {
                val id = chunk.string("id"); valid(id !in textParts, "Duplicate text block")
                textParts[id] = ""; openText += id
            }
            "text-delta" -> {
                val id = chunk.string("id"); valid(id in openText, "Delta without open text block")
                textParts[id] = textParts.getValue(id) + chunk.string("delta", allowEmpty = true)
            }
            "text-end" -> valid(openText.remove(chunk.string("id")), "End without open text block")
            "tool-input-available" -> {
                val id = chunk.string("toolCallId"); valid(id !in tools, "Duplicate tool input")
                tools[id] = ToolState(id, chunk.string("toolName"), chunk["input"] ?: throw ProtocolException("Missing tool input"))
            }
            "tool-output-available", "tool-output-error" -> {
                val id = chunk.string("toolCallId"); val old = tools[id] ?: throw ProtocolException("Tool result without input")
                valid(old.output == null && old.error == null, "Duplicate tool result")
                tools[id] = if (type == "tool-output-available") old.copy(output = chunk["output"] ?: throw ProtocolException("Missing tool output"))
                    else old.copy(error = chunk.string("errorText"))
            }
            "data-instant-submission" -> {
                val data = chunk.requiredData()
                val id = data.string("submissionId")
                valid(state.submissionId == null || state.submissionId == id, "Submission ID changed")
                state = state.copy(submissionId = id, status = data.string("status"))
            }
            "data-instant-device-request" -> {
                val data = chunk.requiredData()
                val request = try { ProtocolJson.decodeFromJsonElement<DeviceRequest>(data) } catch (_: Exception) { throw ProtocolException("Malformed device request") }
                valid(listOf(request.invocationId, request.toolCallId, request.deviceId, request.expiresAt).all { it.isNotBlank() }, "Malformed device request")
                valid(requests[request.invocationId] == null || requests[request.invocationId] == request, "Device request changed")
                requests[request.invocationId] = request
            }
            "data-instant-step" -> runCatching {
                val data = chunk.requiredData()
                val step = StreamStep(chunk.string("id"), data.string("kind"), data.string("title"), data.string("status"), data.optionalString("detail"), data.optionalString("result"))
                steps[step.id] = step
            }.getOrNull()
            "error" -> state = state.copy(errors = state.errors + chunk.string("errorText"))
            "abort" -> state = state.copy(aborted = true)
            "finish" -> { valid(openText.isEmpty() || state.aborted, "Finish with open text block"); state = state.copy(finished = true) }
            else -> valid(type.startsWith("data-"), "Unsupported core stream chunk")
        }
        state = state.copy(text = textParts.values.joinToString(""), tools = tools.values.toList(), deviceRequests = requests.values.toList(), steps = steps.values.toList())
        return state
    }
    fun validateEOF() { valid(state.finished && state.done, "Incomplete message stream") }
    private fun JsonObject.requiredData(): JsonObject {
        val value = this["data"] as? JsonObject ?: throw ProtocolException("Missing stream data")
        valid((value["schemaVersion"] as? JsonPrimitive)?.intOrNull == 1, "Unsupported stream schema")
        return value
    }
    private fun JsonObject.optionalString(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.string(key: String, allowEmpty: Boolean = false): String = optionalString(key)?.takeIf { allowEmpty || it.isNotEmpty() } ?: throw ProtocolException("Missing stream field $key")
    private fun valid(condition: Boolean, message: String) { if (!condition) throw ProtocolException(message) }
}
