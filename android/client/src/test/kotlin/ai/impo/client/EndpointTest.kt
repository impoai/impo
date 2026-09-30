package ai.impo.client

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

/** Covers the concrete production command/query surface, independent from Compose. */
class EndpointTest {
    @Test fun taskCommandsKeepMainAndTaskIdentitiesSeparate() = runBlocking {
        val server = MockWebServer(); server.start()
        try {
            val client = ImpoClient(server.url("/").toString(), StaticTokenProvider("token", "alice"), true)
            server.enqueue(MockResponse().setBody("""{"tasks":[]}""")); assertTrue(client.tasks().isEmpty())
            server.enqueue(MockResponse().setResponseCode(202).setBody("""{"taskId":"task","conversationId":"task-conversation","messageId":"user","submissionId":"run"}"""))
            val create = MessageCommand.create("Research")
            assertEquals("task-conversation", client.createTask(create).conversationId)
            server.enqueue(MockResponse().setBody("""{"taskId":"task","title":"Research","conversationId":"task-conversation","messages":[]}"""))
            assertEquals("task", client.taskConversation("task", afterSequence = 20, limit = 50).taskId)
            server.enqueue(MockResponse().setResponseCode(202).setBody("""{"messageId":"followup","submissionId":"followup-run"}"""))
            client.sendTaskMessage("task", MessageCommand.create("Continue"))
            assertEquals("/api/v1/tasks", server.takeRequest().path)
            val body = ProtocolJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
            assertEquals(setOf("clientMessageId", "text", "clientContext"), body.keys)
            assertEquals("/api/v1/tasks/task/conversation?afterSequence=20&limit=50", server.takeRequest().path)
            assertEquals("/api/v1/tasks/task/messages", server.takeRequest().path)
        } finally { server.shutdown() }
    }
    @Test fun briefMemoryAndConnectorEndpointsDecodePagingAndSendOnlyContractFields() = runBlocking {
        val server = MockWebServer(); server.start()
        try {
            val client = ImpoClient(server.url("/").toString(), StaticTokenProvider("token", "alice"), true)
            server.enqueue(MockResponse().setBody("""{"settings":null}""")); assertNull(client.briefSettings())
            server.enqueue(MockResponse().setBody("""{"briefs":[],"nextCursor":"next-page"}""")); assertEquals("next-page", client.briefs(30, "opaque/+", "2026-09-30").nextCursor)
            val brief = """{"id":"brief","localDate":"2026-09-30","timeZone":"UTC","kind":"daily","label":"Morning","scheduledAt":"now","createdAt":"now","status":"withdrawn","content":{"title":"Stale","summary":"Do not render","cards":[]}}"""
            server.enqueue(MockResponse().setBody(brief)); assertNull(client.brief("brief").visibleContent)
            server.enqueue(MockResponse().setBody("""{"id":"source","kind":"message","recordId":"record","title":"Evidence","occurredAt":"now","version":"1","text":"Current"}""")); assertEquals("Current", client.briefSource("brief", "record").text)
            server.enqueue(MockResponse().setBody("""{"status":"deleted"}""")); client.deleteBrief("brief")
            server.enqueue(MockResponse().setBody("""{"total":1,"categories":{"future_category":1}}""")); assertEquals(1, client.memorySummary().categories["future_category"])
            server.enqueue(MockResponse().setBody("""{"memories":[],"nextCursor":"more"}""")); assertEquals("more", client.memories("travel", "cursor", 50).nextCursor)
            server.enqueue(MockResponse().setBody("""{"status":"deleted"}""")); client.deleteMemory("memory")
            server.enqueue(MockResponse().setBody("""{"connectors":[{"toolkit":"mail","name":"Mail","status":"future_status","featured":true}]}""")); assertEquals("future_status", client.connectors().single().status)
            server.enqueue(MockResponse().setBody("""{"status":"disconnected"}""")); assertEquals("disconnected", client.connectorStatus("mail").status)
            server.enqueue(MockResponse().setBody("""{"redirectURL":"https://authorize.example.com","expiresAt":"later"}""")); assertEquals("https://authorize.example.com", client.connectConnector("mail").redirectURL)
            server.enqueue(MockResponse().setBody("""{"status":"connected","email":"me@example.com"}""")); assertEquals("connected", client.refreshConnector("mail").status)
            server.enqueue(MockResponse().setBody("""{"status":"disconnected"}""")); client.disconnectConnector("mail")
            val requests = (1..13).map { server.takeRequest() }
            assertEquals("/api/v1/today/settings", requests[0].path)
            assertEquals("opaque/+", requests[1].requestUrl!!.queryParameter("cursor")); assertEquals("2026-09-30", requests[1].requestUrl!!.queryParameter("date"))
            assertEquals("/api/v1/today/briefs/brief/sources/record", requests[3].path)
            assertEquals("DELETE", requests[4].method); assertEquals("travel", requests[6].requestUrl!!.queryParameter("category"))
            assertEquals("{}", requests[10].body.readUtf8()); assertEquals("{}", requests[11].body.readUtf8()); assertEquals("DELETE", requests[12].method)
        } finally { server.shutdown() }
    }
    @Test fun echoQueryModesAreSeparateAndMutationsUseServerRecordIds() = runBlocking {
        val server = MockWebServer(); server.start()
        try {
            val client = ImpoClient(server.url("/").toString(), StaticTokenProvider("token", "alice"), true)
            server.enqueue(MockResponse().setBody("""{"timeZone":"Asia/Shanghai","days":[{"date":"2026-09-30","ids":["record"]}]}""")); assertEquals("record", client.echoTimeline("Asia/Shanghai").days.single().ids.single())
            server.enqueue(MockResponse().setBody("""{"timeZone":"UTC","days":[{"date":"2026-09-30","count":1}]}""")); assertEquals(1, client.echoCalendar("UTC").days.single().count)
            server.enqueue(MockResponse().setBody("""{"segments":[]}""")); assertTrue(client.echoRecords(listOf("record")).isEmpty())
            server.enqueue(MockResponse().setBody("""{"segments":[],"nextCursor":"next","previousCursor":"previous"}""")); assertEquals("previous", client.echoHistory("opaque", 25, newer = true).previousCursor)
            server.enqueue(MockResponse().setBody("""{"segments":[]}""")); client.echoRecordsBetween("2026-09-30T00:00:00Z", "2026-10-01T00:00:00Z")
            server.enqueue(MockResponse().setBody("""{"segment":{"id":"record","clientSegmentId":"client-segment","startedAt":"now","endedAt":"later","status":"transcribed","transcript":""}}""")); assertEquals("record", client.updateEchoLabel("record", "Home").id)
            server.enqueue(MockResponse().setBody("""{"status":"deleted"}""")); client.deleteEchoRecord("record")
            server.enqueue(MockResponse().setBody("""{"batchId":"batch","sequence":1,"status":"new_future_state","attempts":2}""")); assertEquals("new_future_state", client.batchStatus("batch").status)
            server.enqueue(MockResponse().setResponseCode(202).setBody("""{"status":"retry_requested"}""")); client.retryBatch("batch")
            val requests = (1..9).map { server.takeRequest() }
            assertEquals(setOf("timeZone"), requests[0].requestUrl!!.queryParameterNames)
            assertEquals(setOf("ids"), requests[2].requestUrl!!.queryParameterNames)
            assertEquals(setOf("limit", "cursor", "direction"), requests[3].requestUrl!!.queryParameterNames)
            assertEquals(setOf("from", "to"), requests[4].requestUrl!!.queryParameterNames)
            assertEquals("/api/v1/listening/segments/record/location", requests[5].path)
            assertEquals(JsonPrimitive("Home"), ProtocolJson.parseToJsonElement(requests[5].body.readUtf8()).jsonObject["label"])
            assertEquals("DELETE", requests[6].method)
            try { client.echoHistory("cursor", before = "now"); fail("Mixed query modes") } catch (_: IllegalArgumentException) {}
            try { client.echoHistory(newer = true); fail("Missing cursor") } catch (_: IllegalArgumentException) {}
        } finally { server.shutdown() }
    }
    @Test fun registrationDefaultsToNoInventedCapabilitiesAndResultBodyOmitsOppositeBranch() = runBlocking {
        val server = MockWebServer(); server.start()
        try {
            val client = ImpoClient(server.url("/").toString(), StaticTokenProvider("token", "alice"), true)
            server.enqueue(MockResponse().setBody("""{"deviceId":"device"}""")); client.registerDevice("installation")
            server.enqueue(MockResponse().setBody("""{"accepted":true,"duplicate":false}""")); client.submitDeviceResult("invocation", DeviceResult("device", "execution", true, JsonObject(emptyMap())))
            server.enqueue(MockResponse().setBody("""{"accepted":true,"duplicate":false}""")); client.submitDeviceResult("invocation", DeviceResult("device", "execution", false, error = "permission_revoked"))
            assertEquals("{\"installationId\":\"installation\",\"tools\":[]}", server.takeRequest().body.readUtf8())
            val success = ProtocolJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
            val failure = ProtocolJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
            assertTrue("output" in success); assertFalse("error" in success); assertTrue("error" in failure); assertFalse("output" in failure)
        } finally { server.shutdown() }
    }
}
