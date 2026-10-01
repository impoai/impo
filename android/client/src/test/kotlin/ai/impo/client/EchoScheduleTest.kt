package ai.impo.client

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class EchoScheduleTest {
    @Test fun optInWeekdaysAndDSTUseAbsoluteWallClockDeadlines() {
        val plan = EchoSchedule(enabled = true, timeZone = "Asia/Shanghai")
        assertEquals(Instant.parse("2026-10-01T10:00:00Z"), plan.nextStop(Instant.parse("2026-10-01T01:15:00Z")))
        assertEquals(Instant.parse("2026-10-05T10:00:00Z"), plan.nextStop(Instant.parse("2026-10-02T11:00:00Z")))
        assertNull(plan.copy(enabled = false).nextStop(Instant.now())); assertNull(plan.copy(autoStop = false).nextStop(Instant.now()))
        val gap = plan.copy(weekdays = listOf(7), reminderTime = "00:00", stopTime = "02:30", timeZone = "America/New_York")
        assertEquals(Instant.parse("2026-03-08T07:30:00Z"), gap.nextStop(Instant.parse("2026-03-08T05:00:00Z")))
        val repeated = gap.copy(stopTime = "01:30")
        assertEquals(Instant.parse("2026-11-01T05:30:00Z"), repeated.nextStop(Instant.parse("2026-11-01T04:00:00Z")))
        assertEquals(Instant.parse("2026-11-08T06:30:00Z"), repeated.nextStop(Instant.parse("2026-11-01T05:45:00Z")))
        assertFalse(plan.copy(weekdays = emptyList()).isValid)
        assertFalse(plan.copy(stopTime = "08:00").isValid)
        assertFalse(plan.copy(timeZone = "Invalid/Zone").isValid)
    }
    @Test fun ownedScheduleTransportIncludesExplicitInitialRevision() = runBlocking {
        MockWebServer().use { server ->
            val client = ImpoClient(server.url("/").toString(), StaticTokenProvider("alice", "alice"), true)
            val response = """{"enabled":true,"weekdays":[1,2,3,4,5],"reminderTime":"09:00","stopTime":"18:00","autoStop":true,"timeZone":"UTC","revision":"b3382f06-aaf4-4b8c-aefd-6ffdf5872b94"}"""
            server.enqueue(MockResponse().setBody(response)); assertTrue(client.saveEchoSchedule(EchoSchedule(enabled = true)).enabled)
            val request = server.takeRequest(); assertEquals("PUT", request.method); assertEquals("/api/v1/echo/schedule", request.path)
            assertEquals("Bearer alice", request.getHeader("Authorization"))
            assertEquals(JsonNull, ProtocolJson.parseToJsonElement(request.body.readUtf8()).jsonObject["revision"])
            server.enqueue(MockResponse().setBody(response)); assertTrue(client.echoSchedule().isValid)
        }
    }
}
