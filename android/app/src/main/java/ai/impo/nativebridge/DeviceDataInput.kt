package ai.impo.nativebridge

import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import ai.impo.client.wireTimestamp
import kotlinx.serialization.json.*

data class DeviceDataInput(val start: Instant, val end: Instant, val timeZone: String,
                           val limit: Int = 50, val metrics: List<String> = emptyList()) {
    fun overlaps(sampleStart: Instant, sampleEnd: Instant): Boolean = when {
        sampleEnd < sampleStart -> false
        sampleEnd == sampleStart -> sampleStart >= start && sampleStart < end
        else -> sampleStart < end && sampleEnd > start
    }
    val range: JsonObject get() = buildJsonObject { put("start", wireTimestamp(start)); put("end", wireTimestamp(end)); put("interval", "[start,end)") }
    companion object {
        private val allowedMetrics = setOf("steps", "active_energy", "heart_rate", "sleep")
        fun parse(input: JsonElement, health: Boolean): DeviceDataInput {
            val fields = input as? JsonObject ?: error("invalid_arguments")
            val allowed = setOf("start", "end", "time_zone", if (health) "metrics" else "limit")
            require(fields.keys.all { it in allowed }) { "invalid_arguments" }
            fun string(key: String): String? = (fields[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
            fun date(key: String): Instant {
                val raw = string(key) ?: error("invalid_date_range")
                require(raw.length <= 40 && raw.matches(Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$"))) { "invalid_date_range" }
                return runCatching { OffsetDateTime.parse(raw).toInstant() }.getOrElse { error("invalid_date_range") }
            }
            val start = date("start"); val end = date("end")
            require(start < end && Duration.between(start, end) <= Duration.ofDays(31)) { "invalid_date_range" }
            val zone = string("time_zone") ?: error("invalid_timezone")
            require(zone.length <= 100 && (zone in ZoneId.getAvailableZoneIds() || zone in setOf("UTC", "GMT"))) { "invalid_timezone" }
            if (health) {
                val values = fields["metrics"] as? JsonArray ?: error("invalid_metrics")
                val metrics = values.map { (it as? JsonPrimitive)?.takeIf { value -> value.isString }?.content ?: error("invalid_metrics") }
                require(metrics.size in 1..4 && metrics.distinct().size == metrics.size && metrics.all { it in allowedMetrics }) { "invalid_metrics" }
                return DeviceDataInput(start, end, zone, metrics = metrics)
            }
            val limit = if (fields.containsKey("limit")) (fields["limit"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
                        ?: error("invalid_limit") else 50
            require(limit in 1..100) { "invalid_limit" }
            return DeviceDataInput(start, end, zone, limit)
        }
    }
}

/** Keep tool envelopes below 64 KiB, even with multibyte native text. */
object DeviceOutputBudget {
    fun bound(output: JsonObject, maximumBytes: Int = 48 * 1024): JsonObject {
        fun fits(value: JsonObject) = value.toString().toByteArray(Charsets.UTF_8).size <= maximumBytes
        if (fits(output)) return output
        var result = JsonObject(output + ("truncated" to JsonPrimitive(true)))
        for (key in listOf("events", "contacts")) {
            var kept = (result[key] as? JsonArray)?.toList() ?: continue
            while (kept.isNotEmpty() && !fits(result)) {
                kept = kept.dropLast(1)
                result = JsonObject(result + mapOf(key to JsonArray(kept), "returned_count" to JsonPrimitive(kept.size)))
            }
        }
        for ((metric, key) in listOf("sleep" to "samples", "steps" to "sources", "active_energy" to "sources", "heart_rate" to "sources")) {
            if (fits(result)) return result
            val metrics = result["metrics"] as? JsonObject ?: continue
            val item = metrics[metric] as? JsonObject ?: continue
            var kept = (item[key] as? JsonArray)?.toList() ?: continue
            while (kept.isNotEmpty() && !fits(result)) {
                kept = kept.dropLast(1)
                val updated = item.toMutableMap().apply { put(key, JsonArray(kept)); put("truncated", JsonPrimitive(true))
                    if (key == "samples") put("returned_sample_count", JsonPrimitive(kept.size)) }
                result = JsonObject(result + ("metrics" to JsonObject(metrics + (metric to JsonObject(updated)))))
            }
        }
        require(fits(result)) { "native_output_too_large" }
        return result
    }
}
