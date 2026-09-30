package ai.impo.nativebridge

import ai.impo.client.*
import java.nio.file.Files
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class DeviceDataTest {
    private val root = Files.createTempDirectory("impo-native-test").toFile()
    private val arguments = buildJsonObject {
        put("start", "2026-09-01T00:00:00Z"); put("end", "2026-09-02T00:00:00Z"); put("time_zone", "UTC"); put("limit", 25)
    }
    @After fun clean() { root.deleteRecursively() }
    @Test fun intervalOverlapUsesHalfOpenBoundaries() {
        val input = DeviceDataInput.parse(arguments, false)
        assertFalse(input.overlaps(input.end, input.end))
        assertTrue(input.overlaps(input.start, input.start))
        assertTrue(input.overlaps(input.start.minusSeconds(1), input.start.plusSeconds(1)))
        assertFalse(input.overlaps(input.start.minusSeconds(1), input.start))
        assertFalse(input.overlaps(input.end, input.start))
    }
    @Test fun inputsRejectInvalidDatesZonesRangesAndUnknownFields() {
        val cases = listOf(
            arguments + ("start" to JsonPrimitive("2026-02-30T00:00:00Z")),
            arguments + ("start" to JsonPrimitive("2026-09-01T24:00:00Z")),
            arguments + ("start" to JsonPrimitive("2026-09-01T00:00:00")),
            arguments + ("end" to arguments.getValue("start")),
            arguments + ("end" to JsonPrimitive("2026-10-03T00:00:00Z")),
            arguments + ("time_zone" to JsonPrimitive("invented/zone")),
            arguments + ("limit" to JsonPrimitive(101)),
            arguments + ("limit" to JsonPrimitive(1.5)),
            arguments + ("limit" to JsonPrimitive("1")),
            arguments + ("write" to JsonPrimitive(true)),
        )
        for (value in cases) assertThrows(RuntimeException::class.java) { DeviceDataInput.parse(JsonObject(value), false) }
    }
    @Test fun healthRequiresDistinctKnownMetrics() {
        val base = arguments - "limit"
        for (values in listOf(emptyList(), listOf("steps", "steps"), listOf("unsupported"))) {
            assertThrows(RuntimeException::class.java) { DeviceDataInput.parse(JsonObject(base + ("metrics" to JsonArray(values.map(::JsonPrimitive)))), true) }
        }
        val input = DeviceDataInput.parse(JsonObject(base + ("metrics" to JsonArray(listOf(JsonPrimitive("steps"), JsonPrimitive("sleep"))))), true)
        assertEquals(listOf("steps", "sleep"), input.metrics)
    }
    @Test fun receiptReplayDoesNotNeedAnotherNativeRead() {
        val store = NativeReceiptStore(root, "a")
        val invocation = DeviceInvocation("invocation", "call", "device-a", "2026-09-02T00:00:00Z", "impo_list_calendar_events", arguments)
        val claim = ToolClaim("execution", invocation.expiresAt)
        val result = DeviceResult("device-a", "execution", true, buildJsonObject { put("events", JsonArray(emptyList())) })
        assertNull(store.load(invocation, claim))
        store.save(invocation, claim, result)
        assertEquals(result, NativeReceiptStore(root, "a").load(invocation, claim))
        assertEquals(result, store.load(invocation.copy(input = JsonObject(arguments.entries.reversed().associate { it.toPair() })), claim))
        store.save(invocation, claim, result)
        assertNull(NativeReceiptStore(root, "b").load(invocation, claim))
        assertThrows(IllegalArgumentException::class.java) { store.load(invocation, claim.copy(executionId = "other")) }
        assertThrows(IllegalArgumentException::class.java) { store.load(invocation.copy(deviceId = "other"), claim) }
        assertThrows(IllegalArgumentException::class.java) { store.load(invocation.copy(input = JsonObject(arguments + ("limit" to JsonPrimitive(1)))), claim) }
        assertThrows(IllegalArgumentException::class.java) { store.save(invocation, claim, result.copy(output = JsonNull)) }
    }
    @Test fun multibyteOutputBudgetPreservesCountsAndMarksTruncation() {
        val events = List(100) { buildJsonObject { put("title", "漢".repeat(300)); put("id", it) } }
        val bounded = DeviceOutputBudget.bound(buildJsonObject {
            put("source", "android.calendar_provider"); put("events", JsonArray(events)); put("returned_count", 100); put("truncated", false)
        }, 4000)
        assertTrue(bounded.toString().toByteArray().size <= 4000)
        assertTrue(bounded["truncated"]!!.jsonPrimitive.boolean)
        assertEquals(bounded["events"]!!.jsonArray.size, bounded["returned_count"]!!.jsonPrimitive.int)
        assertTrue(bounded["events"]!!.jsonArray.isNotEmpty())
    }
    @Test fun sleepBudgetNeverInventsTotalsOrSummedIntervals() {
        val result = DeviceOutputBudget.bound(buildJsonObject {
            put("metrics", buildJsonObject { put("sleep", buildJsonObject {
                put("samples", JsonArray(List(200) { buildJsonObject { put("source", "x".repeat(200)); put("stage", "asleep_light") } }))
                put("total_sleep_seconds", JsonNull); put("returned_sample_count", 200); put("truncated", false)
            }) })
        }, 2000)
        val sleep = result["metrics"]!!.jsonObject["sleep"]!!.jsonObject
        assertEquals(JsonNull, sleep["total_sleep_seconds"])
        assertEquals(sleep["samples"]!!.jsonArray.size, sleep["returned_sample_count"]!!.jsonPrimitive.int)
        assertTrue(sleep["truncated"]!!.jsonPrimitive.boolean)
    }
}
