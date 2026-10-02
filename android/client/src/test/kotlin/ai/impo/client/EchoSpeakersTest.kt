package ai.impo.client

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class EchoSpeakersTest {
    @Test fun confirmationRoundTripsAndOnlySelectedNonexcludedTurnsArePersonal() = runBlocking {
        val id = "11111111-1111-4111-8111-111111111111"
        val raw = """{"id":"$id","clientSegmentId":"$id","startedAt":"2026-10-02T09:00:00Z","endedAt":"2026-10-02T09:01:00Z","status":"transcribed","transcript":"Mine. Other. Excluded.","utterances":[{"id":"u1","speaker":"a","startMs":0,"endMs":1000,"text":"Mine."},{"id":"u2","speaker":"b","startMs":1100,"endMs":2000,"text":"Other."},{"id":"u3","speaker":"a","startMs":2100,"endMs":3000,"text":"Excluded."}],"speakerReview":{"revision":3,"status":"confirmed","selfSpeakerIds":["a"],"excludedUtteranceIds":["u3"]}}"""
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"segment":$raw}""")); server.start()
            val client = ImpoClient(server.url("/").toString(), StaticTokenProvider("test", "test"), allowInsecureLocalhost = true)
            val saved = client.reviewEchoSpeakers(id, EchoSpeakerReview(2, "confirmed", listOf("a"), listOf("u3")))
            val request = server.takeRequest()
            assertEquals("PATCH", request.method); assertEquals("/api/v1/listening/segments/$id/speakers", request.path)
            val sent = ProtocolJson.parseToJsonElement(request.body.readUtf8()).jsonObject
            assertEquals(2, sent["revision"]!!.jsonPrimitive.int)
            assertEquals(listOf("u3"), sent["excludedUtteranceIds"]!!.jsonArray.map { it.jsonPrimitive.content })
            assertEquals(3, saved.speakerReview!!.revision)
            assertEquals(listOf("a", "b"), saved.speakerIds)
            assertEquals("Speaker A", saved.speakerLabel("a"))
            assertEquals("Unknown speaker", saved.speakerLabel(null))
            assertTrue(saved.speakerReview.includes(saved.utterances[0]))
            assertFalse(saved.speakerReview.includes(saved.utterances[1]))
            assertFalse(saved.speakerReview.includes(saved.utterances[2]))
            assertFalse(EchoSpeakerReview().includes(saved.utterances[0]))
        }
    }
}
