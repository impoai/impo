package ai.impo.client

import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.util.UUID

@Serializable data class EchoSchedule(
    val enabled: Boolean = false, val weekdays: List<Int> = listOf(1, 2, 3, 4, 5),
    val reminderTime: String = "09:00", val stopTime: String = "18:00", val autoStop: Boolean = true,
    val timeZone: String = "UTC", val revision: String? = null,
) {
    val isValid: Boolean get() = runCatching {
        val clock = Regex("(?:[01][0-9]|2[0-3]):[0-5][0-9]")
        require(weekdays.isNotEmpty() && weekdays.distinct().size == weekdays.size && weekdays.all { it in 1..7 })
        require(reminderTime.matches(clock) && stopTime.matches(clock) && (!autoStop || stopTime > reminderTime))
        ZoneId.of(timeZone); if (revision != null) require(UUID.fromString(revision).toString() == revision.lowercase())
        true
    }.getOrDefault(false)
    /** Uses the session's original start time, never a renewed recorder/resume timestamp. */
    fun nextStop(anchor: Instant): Instant? {
        if (!enabled || !autoStop || !isValid) return null
        val zone = ZoneId.of(timeZone)
        val date = anchor.atZone(zone).toLocalDate()
        for (offset in 0..8) {
            val day = date.plusDays(offset.toLong())
            if (day.dayOfWeek.value !in weekdays) continue
            val local = day.atTime(LocalTime.parse(stopTime)).atZone(zone).withEarlierOffsetAtOverlap()
            if (local.toLocalDate() == day && local.toInstant() > anchor) return local.toInstant()
        }
        return null
    }
}
