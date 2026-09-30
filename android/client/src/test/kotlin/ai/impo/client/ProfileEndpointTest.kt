package ai.impo.client

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class ProfileEndpointTest {
    @Test fun returningProfileRestoresOptionalFieldsThroughOwnedPrefixedRoute() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"onboarded":true,"assistantName":"Robin","avatarIndex":1,"displayName":"Alex","future":true}"""))
            val client = ImpoClient(server.url("/instant").toString(), StaticTokenProvider("alice-token", "alice"), true)
            assertEquals(AccountProfile(true, "Alex", "Robin", 1), client.profile())
            val request = server.takeRequest()
            assertEquals("GET", request.method)
            assertEquals("/instant/api/v1/profile", request.path)
            assertEquals("Bearer alice-token", request.getHeader("Authorization"))
        }
    }
    @Test fun profilePatchOmitsReadOnlyAndUnspecifiedFieldsAndAllowsOnlyMonotonicOnboarding() = runBlocking {
        MockWebServer().use { server ->
            val client = ImpoClient(server.url("/").toString(), StaticTokenProvider("token", "alice"), true)
            server.enqueue(MockResponse().setBody("""{"onboarded":false,"assistantName":"Wren"}"""))
            assertFalse(client.updateProfile(ProfileUpdate(assistantName = "Wren")).onboarded)
            val name = server.takeRequest()
            assertEquals("PATCH", name.method)
            assertEquals(setOf("assistantName"), ProtocolJson.parseToJsonElement(name.body.readUtf8()).jsonObject.keys)
            server.enqueue(MockResponse().setBody("""{"onboarded":true,"avatarIndex":6}"""))
            assertEquals(6, client.updateProfile(ProfileUpdate(avatarIndex = 6, onboarded = true)).avatarIndex)
            assertEquals(setOf("avatarIndex", "onboarded"), ProtocolJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject.keys)
            assertThrows(IllegalArgumentException::class.java) { ProfileUpdate(onboarded = false) }
            assertThrows(IllegalArgumentException::class.java) { ProfileUpdate(assistantName = " ") }
            assertThrows(IllegalArgumentException::class.java) { ProfileUpdate(avatarIndex = 7) }
            assertEquals(2, server.requestCount)
        }
    }
    @Test fun missingProfileIsNewAccountAndUnavailableProfileIsNotTreatedAsNew() = runBlocking {
        MockWebServer().use { server ->
            val client = ImpoClient(server.url("/").toString(), StaticTokenProvider("token", "alice"), true)
            server.enqueue(MockResponse().setBody("""{"onboarded":false}"""))
            assertEquals(AccountProfile(false), client.profile())
            server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":{"code":"profile_unavailable","message":"Try later","retryable":true}}"""))
            try { client.profile(); fail("Profile outage must not become a new-account profile") }
            catch (expected: ApiException) { assertEquals("profile_unavailable", expected.code); assertTrue(expected.retryable) }
        }
    }
}
