package ai.impo.nativebridge

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import ai.impo.client.wireTimestamp
import androidx.core.content.ContextCompat
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.*
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*

/** Read-only adapters. Permission dialogs are launched only by explicit screen actions. */
class DeviceDataAdapter(private val context: Context) {
    private val contacts = ContactsAdapter(context)
    val contactsGranted get() = contacts.granted
    val calendarGranted get() = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED
    val healthStatus get() = HealthConnectClient.getSdkStatus(context)
    val healthAvailable get() = healthStatus == HealthConnectClient.SDK_AVAILABLE
    val healthPermissions: Set<String> get() = metricPermissions.values.toSet()
    fun healthPermissionContract() = PermissionController.createRequestPermissionResultContract()
    suspend fun grantedHealthPermissions(): Set<String> = if (healthAvailable)
        HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions() else emptySet()

    suspend fun enabledTools(calendarEnabled: Boolean, healthEnabled: Boolean, contactsEnabled: Boolean = false): List<String> = buildList {
        if (calendarEnabled && calendarGranted) add(CALENDAR_TOOL)
        if (healthEnabled && healthAvailable && grantedHealthPermissions().any { it in healthPermissions }) add(HEALTH_TOOL)
        if (contactsEnabled && contactsGranted) add(CONTACTS_TOOL)
    }

    suspend fun execute(toolName: String, input: JsonElement): JsonObject = withContext(Dispatchers.IO) {
        currentCoroutineContext().ensureActive()
        if (toolName == CONTACTS_TOOL) {
            return@withContext try { contacts.search(input) }
            catch (_: SecurityException) { error("permission_revoked") }
        }
        val health = toolName == HEALTH_TOOL
        require(health || toolName == CALENDAR_TOOL) { "unsupported_tool" }
        val arguments = DeviceDataInput.parse(input, health)
        try { DeviceOutputBudget.bound(if (health) healthSummary(arguments) else calendarEvents(arguments)) }
        catch (_: SecurityException) { error("permission_revoked") }
    }

    private fun envelope(input: DeviceDataInput, source: String, truncated: Boolean = false) = buildJsonObject {
        put("source", source); put("observed_at", wireTimestamp(Instant.now())); put("timezone", input.timeZone)
        put("range", input.range); put("truncated", truncated)
    }.toMutableMap()

    private fun calendarEvents(input: DeviceDataInput): JsonObject {
        check(calendarGranted) { "permission_required" }
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also {
            ContentUris.appendId(it, input.start.toEpochMilli()); ContentUris.appendId(it, input.end.toEpochMilli())
        }.build()
        val projection = arrayOf(CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN, CalendarContract.Instances.END, CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.CALENDAR_DISPLAY_NAME, CalendarContract.Instances.OWNER_ACCOUNT,
            CalendarContract.Instances.EVENT_TIMEZONE, CalendarContract.Instances.EVENT_LOCATION)
        val events = mutableListOf<JsonObject>()
        var more = false; var textTruncated = false
        context.contentResolver.query(uri, projection, null, null, "${CalendarContract.Instances.BEGIN} ASC, ${CalendarContract.Instances.EVENT_ID} ASC")?.use { cursor ->
            while (cursor.moveToNext()) {
                val start = Instant.ofEpochMilli(cursor.getLong(2)); val end = Instant.ofEpochMilli(cursor.getLong(3))
                if (!input.overlaps(start, end)) continue
                if (events.size >= input.limit) { more = true; break }
                fun text(index: Int, max: Int): JsonElement {
                    if (cursor.isNull(index)) return JsonNull
                    val raw = cursor.getString(index)
                    if (raw.length > max || raw.contains('\u0000')) textTruncated = true
                    return JsonPrimitive(raw.replace("\u0000", "").take(max))
                }
                events.add(buildJsonObject {
                    put("id", text(0, 512)); put("title", text(1, 300)); put("start", wireTimestamp(start)); put("end", wireTimestamp(end))
                    put("overlap_start", wireTimestamp(maxOf(start, input.start))); put("overlap_end", wireTimestamp(minOf(end, input.end)))
                    put("all_day", cursor.getInt(4) != 0); put("calendar", text(5, 150)); put("source", text(6, 150))
                    put("event_timezone", text(7, 100)); put("location", text(8, 300))
                })
            }
        } ?: error("calendar_unavailable")
        check(calendarGranted) { "permission_revoked" }
        return JsonObject(envelope(input, "android.calendar_provider", more || textTruncated).apply {
            put("events", JsonArray(events)); put("returned_count", JsonPrimitive(events.size)); put("notes_included", JsonPrimitive(false))
            put("text_fields_truncated", JsonPrimitive(textTruncated))
        })
    }

    private suspend fun healthSummary(input: DeviceDataInput): JsonObject {
        val available = healthAvailable
        val client = if (available) HealthConnectClient.getOrCreate(context) else null
        val grants = client?.permissionController?.getGrantedPermissions().orEmpty()
        val metrics = input.metrics.associateWith { metric ->
            currentCoroutineContext().ensureActive()
            try {
                when {
                    !available -> emptyMetric(metric, "unavailable")
                    metricPermissions[metric] !in grants -> emptyMetric(metric, "permission_required")
                    metric == "sleep" -> sleep(checkNotNull(client), input)
                    else -> quantity(checkNotNull(client), input, metric)
                }
            } catch (_: UnsupportedOperationException) { emptyMetric(metric, "unavailable") }
        }
        // Revocation after the read must not cause a successful receipt with stale access.
        val after = client?.permissionController?.getGrantedPermissions().orEmpty()
        check(input.metrics.none { metricPermissions[it] in grants && metricPermissions[it] !in after }) { "permission_revoked" }
        val grantedCount = input.metrics.count { metricPermissions[it] in after }
        return JsonObject(envelope(input, "android.health_connect", metrics.values.any { it["truncated"]?.jsonPrimitive?.booleanOrNull == true }).apply {
            put("metrics", JsonObject(metrics)); put("read_authorization", JsonPrimitive(when {
                !available -> "unavailable"; grantedCount == input.metrics.size -> "granted"; grantedCount == 0 -> "denied"; else -> "partial"
            }))
            put("availability_note", JsonPrimitive("Null means unknown availability, not zero activity. Missing samples may be unsynced or outside the granted history window."))
        })
    }

    private suspend fun quantity(client: HealthConnectClient, input: DeviceDataInput, metric: String): JsonObject {
        val requested = when (metric) {
            "steps" -> setOf(StepsRecord.COUNT_TOTAL)
            "active_energy" -> setOf(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL)
            else -> setOf(HeartRateRecord.BPM_AVG, HeartRateRecord.BPM_MIN, HeartRateRecord.BPM_MAX)
        }
        val result = client.aggregate(AggregateRequest(requested, TimeRangeFilter.between(input.start, input.end)))
        val value: Double? = when (metric) {
            "steps" -> result[StepsRecord.COUNT_TOTAL]?.toDouble()
            "active_energy" -> result[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.inKilocalories
            else -> result[HeartRateRecord.BPM_AVG]?.toDouble()
        }
        return buildJsonObject {
            put("availability", if (value == null) "unknown" else "observed"); put("unit", unit(metric))
            put("method", "Health Connect aggregate; source priority and deduplication are controlled by Health Connect")
            put("boundary_policy", "Health Connect aggregation over [start,end)")
            put("sources", JsonArray(result.dataOrigins.sortedBy { it.packageName }.take(20).map(::source)))
            put("truncated", result.dataOrigins.size > 20)
            if (metric == "heart_rate") {
                put("average", number(value)); put("minimum", number(result[HeartRateRecord.BPM_MIN]?.toDouble()))
                put("maximum", number(result[HeartRateRecord.BPM_MAX]?.toDouble()))
            } else put("value", number(value))
        }
    }

    private suspend fun sleep(client: HealthConnectClient, input: DeviceDataInput): JsonObject {
        val result = client.readRecords(ReadRecordsRequest(SleepSessionRecord::class,
            TimeRangeFilter.between(input.start, input.end), ascendingOrder = false, pageSize = 201))
        val samples = mutableListOf<JsonObject>()
        var truncated = result.records.size > 200 || !result.pageToken.isNullOrEmpty()
        fun add(start: Instant, end: Instant, stage: String, origin: DataOrigin) {
            if (!input.overlaps(start, end) || start == end) return
            if (samples.size >= 200) { truncated = true; return }
            samples.add(buildJsonObject {
                put("start", wireTimestamp(maxOf(start, input.start))); put("end", wireTimestamp(minOf(end, input.end)))
                put("stage", stage); put("source", source(origin))
            })
        }
        result.records.take(200).forEach { record ->
            if (record.stages.isEmpty()) add(record.startTime, record.endTime, "unknown", record.metadata.dataOrigin)
            else record.stages.forEach { stage -> add(stage.startTime, stage.endTime, when (stage.stage) {
                SleepSessionRecord.STAGE_TYPE_AWAKE, SleepSessionRecord.STAGE_TYPE_OUT_OF_BED -> "awake"
                SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED -> "in_bed"
                SleepSessionRecord.STAGE_TYPE_SLEEPING -> "asleep_unspecified"
                SleepSessionRecord.STAGE_TYPE_LIGHT -> "asleep_light"
                SleepSessionRecord.STAGE_TYPE_DEEP -> "asleep_deep"
                SleepSessionRecord.STAGE_TYPE_REM -> "asleep_rem"
                else -> "unknown"
            }, record.metadata.dataOrigin) }
        }
        return buildJsonObject {
            put("availability", if (samples.isEmpty()) "unknown" else "observed"); put("samples", JsonArray(samples))
            put("total_sleep_seconds", JsonNull); put("truncated", truncated); put("returned_sample_count", samples.size)
            put("method", "Newest sessions clipped to [start,end). Stages and sources can overlap. Do not sum durations; no sleep total is computed.")
        }
    }

    private fun source(origin: DataOrigin) = buildJsonObject { put("name", origin.packageName.take(150)); put("package_name", origin.packageName.take(256)) }
    private fun number(value: Double?): JsonElement = if (value != null && value.isFinite()) JsonPrimitive(value) else JsonNull
    private fun unit(metric: String) = when (metric) { "steps" -> "count"; "active_energy" -> "kcal"; else -> "beats/min" }
    private fun emptyMetric(metric: String, availability: String) = buildJsonObject {
        put("availability", availability); put("truncated", false)
        put("method", "No read performed: Health Connect or the required read grant is unavailable")
        if (metric != "sleep") put("boundary_policy", "Health Connect aggregation over [start,end)")
        when (metric) {
            "sleep" -> { put("samples", JsonArray(emptyList())); put("total_sleep_seconds", JsonNull); put("returned_sample_count", 0) }
            "heart_rate" -> { put("unit", unit(metric)); put("sources", JsonArray(emptyList())); put("average", JsonNull); put("minimum", JsonNull); put("maximum", JsonNull) }
            else -> { put("unit", unit(metric)); put("sources", JsonArray(emptyList())); put("value", JsonNull) }
        }
    }
    companion object {
        const val CALENDAR_TOOL = "impo_list_calendar_events"
        const val HEALTH_TOOL = "impo_get_health_summary"
        const val CONTACTS_TOOL = "impo_search_contacts"
        private val metricPermissions = mapOf(
            "steps" to HealthPermission.getReadPermission(StepsRecord::class),
            "active_energy" to HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
            "heart_rate" to HealthPermission.getReadPermission(HeartRateRecord::class),
            "sleep" to HealthPermission.getReadPermission(SleepSessionRecord::class),
        )
    }
}
