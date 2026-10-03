package ai.impo.client

import java.net.URI
import java.net.URLEncoder
import java.util.UUID
import kotlinx.serialization.json.*

/** A proposal from a known server tool. Parsing and history replay never launch an app. */
data class ClientAction private constructor(val id: String, val capability: String, val parameters: JsonObject) {
    val targetUrl: String get() = if (capability == "impo_open_link") parameters.text("url")!! else
        "https://www.google.com/maps/dir/?api=1&destination=${URLEncoder.encode(parameters.text("destination"), "UTF-8")}&travelmode=${parameters.text("mode")}"
    val isVideo: Boolean get() = capability == "impo_open_link" && URI(targetUrl).host?.lowercase().let {
        it == "youtu.be" || it == "youtube.com" || it?.endsWith(".youtube.com") == true
    }
    val title: String get() = if (capability == "impo_navigate") "Get directions" else if (isVideo) "Open video" else "Open link"
    val detail: String get() = if (capability == "impo_navigate") parameters.text("destination")!! else URI(targetUrl).host

    companion object {
        val capabilities = listOf("impo_open_link", "impo_navigate")
        fun from(toolName: String, value: JsonElement?): ClientAction? {
            val output = value as? JsonObject ?: return null
            if (toolName !in capabilities || output.text("kind") != "client_action" || output["schemaVersion"] != JsonPrimitive(1) ||
                output.text("capability") != toolName || output.text("execution") != "device" ||
                output.text("interaction") != "tap" || output.text("status") != "ready") return null
            val id = output.text("actionId") ?: return null
            if (runCatching { UUID.fromString(id).toString().equals(id, ignoreCase = true) }.getOrDefault(false).not()) return null
            val args = output["parameters"] as? JsonObject ?: return null
            if (toolName == "impo_open_link") {
                val raw = args.text("url") ?: return null
                if (args.keys != setOf("url") || raw.length !in 1..4096 || raw.any { it.isWhitespace() || it.isISOControl() || it == '\\' }) return null
                val url = runCatching { URI(raw) }.getOrNull() ?: return null
                if (!url.scheme.equals("https", ignoreCase = true) || url.host.isNullOrEmpty() || url.rawUserInfo != null) return null
            } else {
                val destination = args.text("destination") ?: return null
                if (args.keys != setOf("destination", "mode") || destination.isBlank() || destination.length > 300 || destination.any { it.isISOControl() } ||
                    args.text("mode") !in setOf("driving", "walking", "transit")) return null
            }
            return ClientAction(id, toolName, args)
        }
        fun fromPart(value: JsonElement): ClientAction? {
            val part = value as? JsonObject ?: return null
            if (part.text("type") != "dynamic-tool" || part.text("state") != "output-available") return null
            return from(part.text("toolName") ?: return null, part["output"])
        }
    }
}

private fun JsonObject.text(name: String): String? = (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.content

/** Preserve completed outputs with the message, including during a reconnect. */
internal fun ToolState.part() = buildJsonObject {
    put("type", "dynamic-tool"); put("toolCallId", toolCallId); put("toolName", name); put("input", input)
    put("state", if (output != null) "output-available" else if (error != null) "output-error" else "input-available")
    output?.let { put("output", it) }; error?.let { put("errorText", it) }
}
