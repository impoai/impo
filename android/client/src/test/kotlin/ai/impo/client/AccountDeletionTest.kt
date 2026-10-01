package ai.impo.client

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.UUID

class AccountDeletionTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun deletionRequiresChallengeAndReceiptSurvivesSignedOutIdentity() = runBlocking {
        MockWebServer().use { server ->
            val id = UUID.randomUUID().toString(); val token = "a".repeat(64)
            val api = ImpoClient(server.url("/instant").toString(), StaticTokenProvider("alice-jwt", "alice"), true)
            server.enqueue(MockResponse().setBody("""{"challengeId":"$id","token":"$token","expiresAt":"2026-10-01T01:05:00Z"}"""))
            val challenge = api.prepareAccountDeletion()
            assertEquals("POST", server.takeRequest().method)
            val receipt = """{"requestId":"$id","status":"deleting","requestedAt":"2026-10-01T01:00:00Z","receiptToken":"$token","appleManualRevocationRequired":true}"""
            server.enqueue(MockResponse().setResponseCode(202).setBody(receipt))
            assertTrue(api.deleteAccount(challenge, "DELETE").appleManualRevocationRequired)
            val deletion = server.takeRequest()
            assertEquals("DELETE", deletion.method)
            assertEquals("/instant/api/v1/account", deletion.path)
            assertEquals("Bearer alice-jwt", deletion.getHeader("Authorization"))
            val body = ProtocolJson.parseToJsonElement(deletion.body.readUtf8()).jsonObject
            assertEquals(JsonPrimitive("DELETE"), body["confirmation"])
            assertEquals(JsonPrimitive(token), body["token"])
            val signedOut = ImpoClient(server.url("/instant").toString(), StaticTokenProvider(token, "receipt"), true)
            server.enqueue(MockResponse().setBody(receipt))
            assertEquals(id, signedOut.accountDeletionStatus(id).requestId)
            assertEquals("Bearer $token", server.takeRequest().getHeader("Authorization"))
        }
    }

    @Test fun localCleanupDeletesOnlyOwnedPendingMessagesIncludingInterruptedWrites() = runBlocking {
        val directory = temporary.newFolder(); val store = FileConversationOutboxStore(directory)
        val alice = OutboxEntry(pending = PendingMessage("alice", MessageCommand.create("Private draft")))
        val bob = OutboxEntry(pending = PendingMessage("bob", MessageCommand.create("Keep this draft")))
        store.save(alice); store.save(bob)
        File(directory, "interrupted.json.tmp").writeText(ProtocolJson.encodeToString(alice))
        store.deleteAccount("alice"); store.deleteAccount("alice")
        assertNull(store.load("alice", null))
        assertEquals(bob, store.load("bob", null))
        assertFalse(File(directory, "interrupted.json.tmp").exists())
    }
}
