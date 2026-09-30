package ai.impo.nativebridge

import java.time.Instant
import java.time.temporal.ChronoUnit
import ai.impo.client.wireTimestamp
import kotlinx.serialization.json.*

/** Coordinates deliberately cannot enter this type or the persisted audio store. */
data class PlaceFix(val capturedAt: Instant, val accuracyMeters: Double,
                    val city: String, val country: String, val district: String? = null)

class EchoLocationHistory {
    private val fixes = mutableListOf<PlaceFix>()
    private val stops = mutableListOf<Instant>()

    @Synchronized fun pause(at: Instant = Instant.now()) {
        stops.add(at)
        stops.removeAll { it < at.minusSeconds(1200) }
        while (stops.size > 256) stops.removeAt(0)
    }

    @Synchronized fun add(fix: PlaceFix, now: Instant = Instant.now()) {
        if (!fix.accuracyMeters.isFinite() || fix.accuracyMeters !in 0.0..5000.0 ||
            fix.capturedAt > now || fix.capturedAt < now.minusSeconds(120) ||
            !validPlace(fix.city) || !validPlace(fix.country) || fix.district?.let { !validPlace(it) } == true) return
        if (fixes.lastOrNull()?.let { fix.capturedAt <= it.capturedAt } == true) return
        val clean = if (fix.accuracyMeters > 500) fix.copy(district = null) else fix
        fixes.add(clean)
        fixes.removeAll { it.capturedAt < now.minusSeconds(1200) }
        while (fixes.size > 256) fixes.removeAt(0)
    }

    @Synchronized fun spans(start: Instant, end: Instant): JsonArray = JsonArray(
        if (end <= start) emptyList() else fixes.mapIndexedNotNull { index, fix ->
            val from = maxOf(start, fix.capturedAt).truncatedTo(ChronoUnit.MILLIS)
            val to = minOf(end, fixes.getOrNull(index + 1)?.capturedAt ?: end,
                stops.firstOrNull { it >= fix.capturedAt } ?: end, fix.capturedAt.plusSeconds(120)).truncatedTo(ChronoUnit.MILLIS)
            if (to <= from) null else buildJsonObject {
                put("from", wireTimestamp(from)); put("to", wireTimestamp(to)); put("capturedAt", wireTimestamp(fix.capturedAt))
                put("accuracyMeters", fix.accuracyMeters); put("source", "device")
                put("granularity", if (fix.district == null) "city" else "district")
                put("city", fix.city); put("country", fix.country)
                fix.district?.let { put("district", it) }
            }
        }.take(16)
    )

    private fun validPlace(value: String) = value.isNotBlank() && value.length <= 100 && value.none { it.isISOControl() }
}
