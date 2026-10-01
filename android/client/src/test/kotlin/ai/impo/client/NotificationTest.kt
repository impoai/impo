package ai.impo.client

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.util.UUID

class NotificationTest {
    @Test fun settingsAndRegistrationUseOwnedRoutesAndExplicitNullToken() = runBlocking {
        MockWebServer().use { server ->
            val api = ImpoClient(server.url("/instant").toString(), StaticTokenProvider("alice", "alice"), true)
            server.enqueue(MockResponse().setBody("""{"chat":true,"tasks":false,"brief":true}"""))
            assertFalse(api.updateNotificationPreference("tasks", false).tasks)
            val patch = server.takeRequest()
            assertEquals("PATCH", patch.method)
            assertEquals("/instant/api/v1/notifications/settings", patch.path)
            assertEquals("Bearer alice", patch.getHeader("Authorization"))
            assertEquals(buildJsonObject { put("tasks", false) }, ProtocolJson.parseToJsonElement(patch.body.readUtf8()))
            val installation = UUID.randomUUID().toString(); val secret = UUID.randomUUID().toString(); val registration = UUID.randomUUID().toString()
            server.enqueue(MockResponse().setBody("""{"registrationId":"$registration"}"""))
            assertEquals(registration, api.registerPush(installation, secret, 2, registration, null, false, true).registrationId)
            val request = server.takeRequest(); val body = ProtocolJson.parseToJsonElement(request.body.readUtf8()).jsonObject
            assertEquals("PUT", request.method)
            assertEquals("/instant/api/v1/notifications/installations/$installation", request.path)
            assertEquals(JsonNull, body["token"])
            assertEquals(JsonPrimitive(true), body["foreground"])
            assertEquals(JsonPrimitive("android"), body["platform"])
            server.enqueue(MockResponse().setBody("""{"revoked":true}"""))
            api.revokePush(installation, secret, 3, registration)
            val revoke = server.takeRequest()
            assertEquals("DELETE", revoke.method)
            assertEquals(setOf("installationSecret", "revision", "registrationId"), ProtocolJson.parseToJsonElement(revoke.body.readUtf8()).jsonObject.keys)
        }
    }
    @Test fun pushRoutesRejectWrongAccountExpiredAndMalformedMessages() {
        val registration = UUID.randomUUID().toString()
        val data = mapOf("version" to "1", "eventId" to UUID.randomUUID().toString(), "registrationId" to registration,
            "targetId" to UUID.randomUUID().toString(), "category" to "tasks", "expiresAt" to "2026-10-01T01:00:00.000Z")
        val route = checkNotNull(PushRoute.parse(data))
        assertTrue(route.isCurrent(registration, Instant.parse("2026-10-01T00:00:00Z")))
        assertFalse(route.isCurrent(UUID.randomUUID().toString(), Instant.parse("2026-10-01T00:00:00Z")))
        assertFalse(route.isCurrent(registration, Instant.parse("2026-10-01T01:00:00Z")))
        for ((key, value) in listOf("version" to "2", "category" to "echo", "targetId" to "1-1-1-1-1", "expiresAt" to "invalid"))
            assertNull(PushRoute.parse(data + (key to value)))
    }
}
