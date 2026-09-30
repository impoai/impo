package ai.impo.client

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.IOException

class DurableTaskCreatorTest {
    @get:Rule val temporary = TemporaryFolder()
    private val receipt = """{"taskId":"task","conversationId":"conversation","messageId":"user","submissionId":"run"}"""
    private fun client(server: MockWebServer, owner: String = "alice") = ImpoClient(server.url("/").toString(), StaticTokenProvider("token", owner), true, OkHttpClient.Builder().retryOnConnectionFailure(false).build())
    @Test fun lostTaskAcceptanceAndProcessRestartPreserveExactCommandThenRecoverSavedReceipt() = runBlocking {
        val server = MockWebServer(); server.start()
        try {
            val directory = temporary.newFolder()
            val first = DurableTaskCreator(client(server), "alice", FileConversationOutboxStore(directory))
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            try { first.create("Research something"); fail("Expected lost acceptance") } catch (_: IOException) {}
            val command = first.pendingCommand()!!
            val restarted = DurableTaskCreator(client(server), "alice", FileConversationOutboxStore(directory))
            assertEquals(command, restarted.pendingCommand())
            server.enqueue(MockResponse().setResponseCode(202).setBody(receipt))
            assertEquals("task", restarted.retry()!!.taskId)
            assertEquals(server.takeRequest().body.readUtf8(), server.takeRequest().body.readUtf8())
            val accepted = DurableTaskCreator(client(server), "alice", FileConversationOutboxStore(directory))
            assertEquals("task", accepted.retry()!!.taskId)
            assertEquals(2, server.requestCount) // Saved acceptance is replayed without another POST.
            try { accepted.acknowledge("other-task"); fail("Expected mismatch") } catch (_: ProtocolException) {}
            assertNotNull(accepted.pendingCommand())
            accepted.acknowledge("task"); assertNull(accepted.pendingCommand())
        } finally { server.shutdown() }
    }
    @Test fun changingUncertainTaskTextOrSwitchingAccountsCannotDiscardPendingWork() = runBlocking {
        val server = MockWebServer(); server.start()
        try {
            val store = MemoryConversationOutboxStore(); val creator = DurableTaskCreator(client(server), "alice", store)
            server.enqueue(MockResponse().setResponseCode(503))
            try { creator.create("Original"); fail("Expected unavailable") } catch (_: ApiException) {}
            try { creator.create("Changed"); fail("Expected preserved task") } catch (_: IllegalStateException) {}
            assertEquals("Original", creator.pendingCommand()!!.text); assertEquals(1, server.requestCount)
            assertNull(DurableTaskCreator(client(server, "bob"), "bob", store).pendingCommand())
            try { DurableTaskCreator(client(server, "bob"), "alice", store).retry(); fail("Expected ownership rejection") } catch (_: AccountChangedException) {}
            assertEquals(1, server.requestCount)
        } finally { server.shutdown() }
    }
}
