package ai.impo.client

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class ScheduledTasksTest {
    @Test fun commandsPreserveNullsIdentityRevisionAndIndependentNotificationPreference() = runBlocking {
        MockWebServer().use { server ->
            val client = ImpoClient(server.url("/").toString(), StaticTokenProvider("alice", "alice"), true)
            val id = "a06eb94f-b2a2-484a-9bc4-cfcb67a629bc"
            val row = """{"id":"$id","title":"News","goal":"Research news","schedule":{"frequency":"daily","timeZone":"UTC","runAt":null,"time":"09:00","weekdays":[]},"enabled":true,"revision":"$id","nextRunAt":null,"createdAt":"2026-10-01T09:00:00Z","updatedAt":"2026-10-01T09:00:00Z"}"""
            server.enqueue(MockResponse().setResponseCode(201).setBody(row))
            val saved = client.createScheduledTask(ScheduledTaskInput("News", "Research news", TaskSchedule(timeZone = "UTC")), id)
            val create = server.takeRequest(); assertEquals("POST", create.method); assertEquals("/api/v1/scheduled-tasks", create.path)
            val body = ProtocolJson.parseToJsonElement(create.body.readUtf8()).jsonObject
            assertEquals(id, body["clientRequestId"]!!.jsonPrimitive.content)
            assertEquals(JsonNull, body["schedule"]!!.jsonObject["runAt"])
            server.enqueue(MockResponse().setBody(row)); client.updateScheduledTask(id, saved.revision, saved.input.copy(enabled = false))
            val update = ProtocolJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
            assertEquals(id, update["revision"]!!.jsonPrimitive.content); assertFalse(update["enabled"]!!.jsonPrimitive.boolean)
            server.enqueue(MockResponse().setBody("""{"runs":[],"nextCursor":null}""")); client.scheduledTaskRuns(id, "cursor")
            assertEquals("/api/v1/scheduled-tasks/$id/runs?before=cursor", server.takeRequest().path)
            server.enqueue(MockResponse().setBody("""{"chat":true,"tasks":true,"brief":true,"scheduledTasks":false}"""))
            assertFalse(client.updateNotificationPreference("scheduledTasks", false).scheduledTasks)
            assertEquals("""{"scheduledTasks":false}""", server.takeRequest().body.readUtf8())
            server.enqueue(MockResponse().setBody("""{"deleted":true}""")); client.deleteScheduledTask(id, saved.revision)
            assertEquals("DELETE", server.takeRequest().method)
        }
    }
}
