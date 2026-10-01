package ai.impo.client

import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.ZoneId
import java.util.Base64
import java.util.UUID

/** An immutable snapshot of one short recording. This is not an Echo upload. */
@Serializable data class VoiceClip(val audio: String, val mimeType: String) {
    init { validateVoiceClip(audio, mimeType) }
    override fun toString() = "VoiceClip(mimeType=$mimeType, audio=<redacted>)"
    companion object {
        const val MAX_BYTES = 2 * 1024 * 1024
        fun fromBytes(bytes: ByteArray, mimeType: String): VoiceClip {
            require(bytes.size in 1..MAX_BYTES) { "Voice recordings must contain at most 2 MiB of audio" }
            return VoiceClip(Base64.getEncoder().encodeToString(bytes), mimeType)
        }
    }
}

/** Freeze identity, bytes and clock context before the first admission attempt. */
@Serializable data class VoiceMessageCommand(
    val clientMessageId: String,
    val audio: String,
    val mimeType: String,
    val clientContext: ClientContext? = null,
) {
    init {
        require(clientMessageId.isNotBlank() && clientMessageId.length <= 256 && '\u0000' !in clientMessageId)
        validateVoiceClip(audio, mimeType)
    }
    override fun toString() = "VoiceMessageCommand(clientMessageId=$clientMessageId, mimeType=$mimeType, audio=<redacted>)"
    companion object {
        fun create(clip: VoiceClip, timeZone: String = ZoneId.systemDefault().id, now: Instant = Instant.now()) =
            VoiceMessageCommand(UUID.randomUUID().toString(), clip.audio, clip.mimeType, ClientContext(timeZone, wireTimestamp(now)))
    }
}
@Serializable data class VoiceMessageReceipt(val messageId: String, val submissionId: String, val text: String)
@Serializable internal data class VoiceTranscription(val text: String)
@Serializable data class PendingVoiceMessage(val accountId: String, val command: VoiceMessageCommand, val deviceId: String? = null) {
    init { require(accountId.isNotBlank()) }
    suspend fun send(client: ImpoClient): VoiceMessageReceipt {
        if (client.currentAccountId() != accountId) throw AccountChangedException()
        return client.sendVoiceMessage(command, deviceId)
    }
}
/** Only unacknowledged clips appear here; the accepted user message contains the returned transcript. */
data class PendingVoiceState(val clientMessageId: String, val transcribing: Boolean, val retryable: Boolean = true)

private fun validateVoiceClip(audio: String, mimeType: String) {
    require(mimeType in setOf("audio/mp4", "audio/m4a", "audio/aac", "audio/mpeg", "audio/wav", "audio/ogg", "audio/webm", "audio/flac")) { "Unsupported voice audio format" }
    require(audio.isNotEmpty() && audio.length <= ((VoiceClip.MAX_BYTES + 2) / 3) * 4) { "Voice recording is empty or too large" }
    val decoded = Base64.getDecoder().decode(audio)
    require(decoded.size in 1..VoiceClip.MAX_BYTES && Base64.getEncoder().encodeToString(decoded) == audio) { "Voice audio must use canonical base64" }
}
internal fun validateVoiceText(text: String): String {
    if (text.isBlank() || text.length > 32_768 || '\u0000' in text) throw ProtocolException("Voice response has no valid transcript")
    return text
}
