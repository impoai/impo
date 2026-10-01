package ai.impo.client

import kotlinx.serialization.Serializable
import java.time.Instant
import java.util.UUID

@Serializable data class NotificationPreferences(val chat: Boolean = true, val tasks: Boolean = true, val brief: Boolean = true, val echo: Boolean = true, val scheduledTasks: Boolean = true) {
    fun enabled(category: String) = when (category) { "chat" -> chat; "tasks" -> tasks; "scheduledTasks" -> scheduledTasks; "brief" -> brief; "echo" -> echo; else -> false }
    fun setting(category: String, value: Boolean) = when (category) {
        "chat" -> copy(chat = value); "tasks" -> copy(tasks = value); "scheduledTasks" -> copy(scheduledTasks = value); "brief" -> copy(brief = value); "echo" -> copy(echo = value); else -> error("Unknown notification category")
    }
}
@Serializable data class PushRegistrationReceipt(val registrationId: String)
@Serializable data class PushRevocationReceipt(val revoked: Boolean)
@Serializable data class PushRoute(val eventId: String, val registrationId: String, val category: String, val targetId: String, val expiresAt: String) {
    fun isCurrent(registration: String?, now: Instant = Instant.now()) = registration == registrationId && runCatching { Instant.parse(expiresAt) > now }.getOrDefault(false)
    companion object {
        fun parse(data: Map<String, String>): PushRoute? = runCatching {
            require(data["version"] == "1" && data["category"] in setOf("chat", "tasks", "scheduledTasks", "brief", "echo"))
            listOf("eventId", "registrationId", "targetId").forEach { require(UUID.fromString(data.getValue(it)).toString() == data.getValue(it).lowercase()) }
            Instant.parse(data.getValue("expiresAt"))
            PushRoute(data.getValue("eventId"), data.getValue("registrationId"), data.getValue("category"), data.getValue("targetId"), data.getValue("expiresAt"))
        }.getOrNull()
    }
}
