package ai.impo.client

import kotlinx.serialization.Serializable

@Serializable data class UploadedAttachment(val id: String, val name: String, val mediaType: String, val sizeBytes: Long, val status: String) {
    val deliveredFile: DeliveredFile get() = DeliveredFile("upload_$id", name, mediaType, sizeBytes)
}
@Serializable data class AttachmentManifest(val id: String, val name: String, val mediaType: String, val sizeBytes: Int, val sha256: String)
@Serializable data class AttachmentUploadTicket(val status: String, val url: String? = null, val headers: Map<String, String> = emptyMap())

val attachmentFormats = mapOf("pdf" to "application/pdf", "doc" to "application/msword",
    "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "txt" to "text/plain",
    "md" to "text/markdown", "csv" to "text/csv", "json" to "application/json", "jpg" to "image/jpeg",
    "jpeg" to "image/jpeg", "png" to "image/png", "gif" to "image/gif", "webp" to "image/webp")
