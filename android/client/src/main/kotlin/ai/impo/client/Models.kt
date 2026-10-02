package ai.impo.client

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID

private val timestampFormatter = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
/** The shared API accepts ISO instants at millisecond precision. */
fun wireTimestamp(instant: Instant): String = timestampFormatter.format(instant)

@Serializable data class AccountProfile(
    val onboarded: Boolean,
    val displayName: String? = null,
    val assistantName: String? = null,
    val avatarIndex: Int? = null,
    val mode: String? = null,
)
/** Account fields only. Display name comes from Brief settings; device permissions stay local. */
@Serializable data class ProfileUpdate(
    val assistantName: String? = null,
    val avatarIndex: Int? = null,
    val onboarded: Boolean? = null,
    val mode: String? = null,
) {
    init {
        require(assistantName == null || (assistantName.trim().isNotEmpty() && assistantName.trim().length <= 30 && '\u0000' !in assistantName))
        require(avatarIndex == null || avatarIndex in 0..6)
        require(onboarded == null || onboarded)
        require(mode == null || mode in setOf("Balanced", "Power"))
    }
}

/** Freeze this command before the first send and retain it until acceptance is known. */
@Serializable data class MessageCommand(
    val clientMessageId: String,
    val text: String,
    val clientContext: ClientContext? = null,
) {
    init {
        require(clientMessageId.isNotBlank() && clientMessageId.length <= 256 && '\u0000' !in clientMessageId)
        require(text.isNotBlank() && text.length <= 32_768 && '\u0000' !in text)
    }
    companion object {
        fun create(text: String, timeZone: String = ZoneId.systemDefault().id, now: Instant = Instant.now()) =
            MessageCommand(UUID.randomUUID().toString(), text, ClientContext(timeZone, wireTimestamp(now)))
    }
}
@Serializable data class ClientContext(val timeZone: String, val currentDate: String)
@Serializable data class MessageReceipt(val messageId: String, val submissionId: String)
@Serializable data class TaskReceipt(val taskId: String, val conversationId: String, val messageId: String, val submissionId: String)
@Serializable data class ErrorDetail(val code: String, val message: String, val retryable: Boolean = false)
@Serializable data class Submission(
    val submissionId: String, val messageId: String, val status: String,
    val resultCount: Int = 0, val subscriberCount: Int = 0, val version: Int = 0,
    val cancelRequested: Boolean = false, val error: ErrorDetail? = null,
) { val isTerminal get() = status in setOf("completed", "failed", "cancelled") }
@Serializable data class ConversationMessage(
    val id: String, val role: String, val sequence: Int, val text: String,
    val status: String, val createdAt: String, val parts: List<JsonElement> = emptyList(),
) {
    /** Files delivered with an assistant reply, from its `data-instant-file` parts. */
    val files: List<DeliveredFile> get() = parts.mapNotNull { part ->
        val value = part as? JsonObject ?: return@mapNotNull null
        if ((value["type"] as? JsonPrimitive)?.contentOrNull != "data-instant-file") null else DeliveredFile.from(value["data"])
    }.distinctBy { it.fileId }
}
/** A file an assistant reply delivered; download it with [ImpoClient.downloadFile]. */
@Serializable data class DeliveredFile(val fileId: String, val name: String, val mediaType: String, val sizeBytes: Long) {
    /** One safe path component: the server name without separators or a leading dot. */
    val localName: String get() = name.filterNot { it.isISOControl() }.replace('/', '_').replace('\\', '_').replace(':', '_').trim { it == '.' || it.isWhitespace() }.ifEmpty { "file" }
    fun part(): JsonObject = buildJsonObject {
        put("type", "data-instant-file"); put("id", fileId)
        put("data", buildJsonObject { put("schemaVersion", 1); put("fileId", fileId); put("name", name); put("mediaType", mediaType); put("sizeBytes", sizeBytes) })
    }
    companion object {
        /** Schema version 1 data, or null for anything that is not a usable file. */
        fun from(data: JsonElement?): DeliveredFile? {
            val value = data as? JsonObject ?: return null
            fun text(key: String) = (value[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
            if ((value["schemaVersion"] as? JsonPrimitive)?.intOrNull != 1) return null
            val fileId = text("fileId")?.takeIf { it.isNotEmpty() } ?: return null
            val name = text("name")?.takeIf { it.isNotEmpty() } ?: return null
            val size = (value["sizeBytes"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it >= 0 } ?: return null
            return DeliveredFile(fileId, name, text("mediaType") ?: return null, size)
        }
    }
}
@Serializable data class ActiveSubmission(val submissionId: String, val messageId: String, val status: String)
@Serializable data class ConversationPage(
    val conversationId: String, val messages: List<ConversationMessage>,
    val activeSubmissions: List<ActiveSubmission> = emptyList(), val hasMore: Boolean = false,
    val nextAfterSequence: Int = 0,
)
@Serializable data class TaskConversationPage(
    val taskId: String, val title: String, val conversationId: String,
    val messages: List<ConversationMessage>, val activeSubmissions: List<ActiveSubmission> = emptyList(),
    val hasMore: Boolean = false, val nextAfterSequence: Int = 0,
)
@Serializable data class TaskSummary(
    val taskId: String, val conversationId: String, val title: String, val status: String,
    val createdAt: String, val updatedAt: String? = null,
    val lastRunStartedAt: String? = null, val lastRunCompletedAt: String? = null,
)
@Serializable data class BriefSlot(val id: String, val label: String, val hour: Int, val enabled: Boolean)
@Serializable data class BriefLocation(val city: String, val country: String, val capturedAt: String, val source: String? = null)
@Serializable data class BriefSettings(
    val timeZone: String, val locale: String, val displayName: String = "",
    val location: BriefLocation? = null, val slots: List<BriefSlot> = emptyList(),
)
@Serializable data class BriefLink(val title: String, val url: String)
@Serializable data class BriefCard(
    val style: String, val eyebrow: String, val title: String, val body: String,
    val bullets: List<String> = emptyList(), val sourceIds: List<String> = emptyList(),
    val links: List<BriefLink> = emptyList(),
)
@Serializable data class BriefContent(val title: String, val summary: String, val cards: List<BriefCard>)
@Serializable data class BriefSource(
    val id: String, val kind: String, val recordId: String, val title: String,
    val occurredAt: String, val version: String, val occurredLocalDate: String? = null,
    val text: String? = null, val location: EchoLocationContext? = null,
)
@Serializable data class Brief(
    val id: String, val localDate: String, val timeZone: String, val kind: String,
    val label: String, val scheduledAt: String, val createdAt: String, val status: String,
    val completedAt: String? = null, val content: BriefContent? = null, val errorCode: String? = null,
    val inputCutoff: String? = null, val inputTruncated: Boolean = false,
    val sources: List<BriefSource> = emptyList(),
) { val visibleContent get() = content.takeIf { status == "completed" } }
@Serializable data class BriefPage(val briefs: List<Brief>, val nextCursor: String? = null)
@Serializable data class Memory(
    val id: String, val content: String, val categories: List<String>, val sourceIds: List<String>,
    val createdAt: String, val updatedAt: String, val expiresAt: String? = null,
)
@Serializable data class MemorySummary(val total: Int, val categories: Map<String, Int>)
@Serializable data class MemoryPage(val memories: List<Memory>, val nextCursor: String? = null)
@Serializable data class ConnectorStatus(val status: String, val email: String? = null, val expiresAt: String? = null)
@Serializable data class Connector(
    val toolkit: String, val name: String, val status: String, val featured: Boolean = false,
    val description: String? = null, val logoURL: String? = null, val email: String? = null,
    val expiresAt: String? = null,
)
@Serializable data class ConnectorAuthorization(val redirectURL: String, val expiresAt: String)
@Serializable data class EchoLocationSpan(
    val from: String, val to: String, val capturedAt: String, val accuracyMeters: Double,
    val source: String = "device", val granularity: String, val city: String, val country: String,
    val district: String? = null,
)
@Serializable data class EchoLocationContext(
    val spans: List<EchoLocationSpan> = emptyList(), val label: String? = null,
    val source: String? = null, val truncated: Boolean = false,
)
@Serializable data class EchoRecord(
    val id: String, val clientSegmentId: String, val startedAt: String, val endedAt: String,
    val status: String, val transcript: String = "", val model: String? = null,
    val error: ErrorDetail? = null, val batchId: String? = null, val segmentCount: Int? = null,
    val audioMilliseconds: Int? = null, val cursor: String? = null, val location: EchoLocationContext? = null,
)
@Serializable data class EchoPage(val segments: List<EchoRecord>, val nextCursor: String? = null, val previousCursor: String? = null)
@Serializable data class EchoTimelineDay(val date: String, val ids: List<String>)
@Serializable data class EchoTimeline(val timeZone: String, val days: List<EchoTimelineDay>)
@Serializable data class EchoCalendarDay(val date: String, val count: Int)
@Serializable data class EchoCalendar(val timeZone: String, val days: List<EchoCalendarDay>)
@Serializable data class AudioItem(
    val segmentId: String, val startedAt: String, val endedAt: String, val mimeType: String,
    val audio: String, val locations: List<EchoLocationSpan>? = null,
)
@Serializable data class SealedBatch(val batchId: String, val streamId: String, val sequence: Int, val sessionId: String, val items: List<AudioItem>)
@Serializable data class ManifestItem(
    val segmentId: String, val startedAt: String, val endedAt: String, val mimeType: String,
    val audioBytes: Int, val locations: List<EchoLocationSpan>? = null,
)
@Serializable data class ManifestBatch(val batchId: String, val streamId: String, val sequence: Int, val sessionId: String, val items: List<ManifestItem>)
@Serializable data class UploadManifest(val batch: ManifestBatch, val sha256: String, val byteLength: Int)
@Serializable data class BatchReceipt(val batchId: String, val streamId: String, val sequence: Int, val status: String)
@Serializable data class UploadTicket(
    val status: String, val url: String? = null, val headers: Map<String, String> = emptyMap(),
    val expiresAt: String? = null, val receipt: BatchReceipt? = null,
)
@Serializable data class BatchStatus(
    val batchId: String, val sequence: Int, val status: String, val attempts: Int = 0,
    val error: ErrorDetail? = null, val updatedAt: String? = null,
)
@Serializable data class RegisteredDevice(val deviceId: String)
@Serializable data class DeviceInvocation(
    val invocationId: String, val toolCallId: String, val deviceId: String,
    val expiresAt: String, val toolName: String, val input: JsonElement,
)
@Serializable data class ToolClaim(val executionId: String, val expiresAt: String)
@Serializable data class DeviceResult(
    val deviceId: String, val executionId: String, val success: Boolean,
    val output: JsonElement? = null, val error: String? = null,
) {
    init { require(if (success) output != null && error == null else output == null && !error.isNullOrBlank() && error.length <= 4096) }
}
@Serializable data class ToolResultReceipt(val accepted: Boolean, val duplicate: Boolean)
@Serializable internal data class TasksResponse(val tasks: List<TaskSummary>)
@Serializable internal data class ConnectorsResponse(val connectors: List<Connector>)
@Serializable internal data class SettingsResponse(val settings: BriefSettings? = null)
@Serializable internal data class InvocationsResponse(val invocations: List<DeviceInvocation>)
@Serializable internal data class SegmentResponse(val segment: EchoRecord)
@Serializable internal data class StatusResponse(val status: String)
@Serializable data class AccountDeletionChallenge(val challengeId: String, val token: String, val expiresAt: String)
@Serializable data class AccountDeletionReceipt(val requestId: String, val status: String, val requestedAt: String, val receiptToken: String? = null, val appleManualRevocationRequired: Boolean = false)
