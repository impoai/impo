package ai.impo.client

import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class ConversationSessionTest {
    private val receipt = """{"messageId":"user","submissionId":"run"}"""
    private fun run(status: String) = """{"submissionId":"run","messageId":"assistant","status":"$status"}"""
    private fun message(id: String, role: String, sequence: Int, text: String, status: String = "completed") = """{"id":"$id","role":"$role","sequence":$sequence,"text":"$text","status":"$status","createdAt":"2026-09-30T00:00:00Z"}"""
    private fun page(messages: String = "", active: Boolean = false, more: Boolean = false, cursor: Int = 0) = """{"conversationId":"main","messages":[$messages],"activeSubmissions":[${if (active) """{"submissionId":"run","messageId":"assistant","status":"running"}""" else ""}],"hasMore":$more,"nextAfterSequence":$cursor}"""
    private fun stream() = listOf("""{"type":"start","messageId":"assistant"}""", """{"type":"text-start","id":"text"}""",
        """{"type":"text-delta","id":"text","delta":"Final response"}""", """{"type":"text-end","id":"text"}""",
        """{"type":"data-instant-submission","data":{"schemaVersion":1,"submissionId":"run","status":"completed"}}""", """{"type":"finish"}""", "[DONE]").joinToString("") { "data: $it\n\n" }
    private fun client(server: MockWebServer) = ImpoClient(server.url("/").toString(), StaticTokenProvider("token", "alice"), true,
        OkHttpClient.Builder().retryOnConnectionFailure(false).readTimeout(2, TimeUnit.SECONDS).build())

    @Test fun lostAcceptancePersistsFrozenCommandThenRestartRetriesAndRecovers() = runBlocking {
        val server = MockWebServer(); server.start()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val posted = CopyOnWriteArrayList<String>(); val sends = AtomicInteger(); var complete = false
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when {
                    request.path == "/api/v1/conversation/messages" -> {
                        posted += request.body.readUtf8()
                        if (sends.incrementAndGet() == 1) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                        else MockResponse().setResponseCode(202).setBody(receipt)
                    }
                    request.path == "/api/v1/submissions/run" -> MockResponse().setBody(run(if (complete) "completed" else "running"))
                    request.path == "/api/v1/submissions/run/stream" -> { complete = true; MockResponse().setHeader("Content-Type", "text/event-stream").setHeader("x-vercel-ai-ui-message-stream", "v1").setBody(stream()) }
                    request.path!!.startsWith("/api/v1/conversation?") -> MockResponse().setBody(page(message("user", "user", 1, "Hello") + "," + message("assistant", "assistant", 2, "Final response")))
                    else -> MockResponse().setResponseCode(404)
                }
            }
            val store = MemoryConversationOutboxStore()
            val first = ConversationSession(client(server), "alice", store = store, scope = scope, deviceId = { "device" })
            first.send("Hello")
            assertTrue(first.state.value.hasPendingMessage); assertNotNull(first.state.value.error)
            val original = store.load("alice", null)!!
            assertNull(original.receipt); assertEquals("device", original.pending!!.deviceId)
            first.close()
            val reopened = ConversationSession(client(server), "alice", store = store, scope = scope)
            reopened.retryPending()
            withTimeout(5000) { while (reopened.state.value.messages.none { it.text == "Final response" } || reopened.state.value.hasPendingMessage) delay(20) }
            assertEquals(2, sends.get()); assertEquals(posted[0], posted[1])
            assertNull(store.load("alice", null)); assertFalse(reopened.state.value.busy)
            reopened.close()
        } finally { scope.cancel(); server.shutdown() }
    }
    @Test fun acceptedReceiptAfterRestartRecoversWithoutResubmittingPrompt() = runBlocking {
        val server = MockWebServer(); server.start(); val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val store = MemoryConversationOutboxStore()
            store.save(OutboxEntry(PendingMessage("alice", MessageCommand.create("Hello")), MessageReceipt("user", "run")))
            val methods = CopyOnWriteArrayList<String>()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    methods += request.method!!
                    return if (request.path == "/api/v1/submissions/run") MockResponse().setBody(run("completed"))
                    else MockResponse().setBody(page(message("user", "user", 1, "Hello"), false))
                }
            }
            val session = ConversationSession(client(server), "alice", store = store, scope = scope)
            session.retryPending()
            withTimeout(5000) { while (session.state.value.hasPendingMessage) delay(20) }
            assertTrue(methods.all { it == "GET" }); assertNull(store.load("alice", null)); session.close()
        } finally { scope.cancel(); server.shutdown() }
    }
    @Test fun refreshStartsAtZeroAndLoadsAllPagesIncludingUpdatedEarlierMessages() = runBlocking {
        val server = MockWebServer(); server.start(); val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            server.enqueue(MockResponse().setBody(page(message("a", "assistant", 1, "Partial"))))
            val session = ConversationSession(client(server), "alice", store = MemoryConversationOutboxStore(), scope = scope)
            session.refresh()
            server.enqueue(MockResponse().setBody(page(message("a", "assistant", 1, "Final"), more = true, cursor = 1)))
            server.enqueue(MockResponse().setBody(page(message("b", "user", 2, "Later"))))
            session.refresh()
            assertEquals(listOf("Final", "Later"), session.state.value.messages.map { it.text })
            assertTrue(server.takeRequest().path!!.contains("afterSequence=0")); assertTrue(server.takeRequest().path!!.contains("afterSequence=0")); assertTrue(server.takeRequest().path!!.contains("afterSequence=1"))
            session.close()
        } finally { scope.cancel(); server.shutdown() }
    }
    @Test fun closeOnlyDetachesWhileExplicitCancelUsesCommand() = runBlocking {
        val server = MockWebServer(); server.start(); val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val paths = CopyOnWriteArrayList<String>(); var cancelled = false
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    paths += request.path!!
                    return when {
                        request.path!!.endsWith("/cancel") -> { cancelled = true; MockResponse().setBody(run("cancelled")) }
                        request.path!!.endsWith("/stream") -> MockResponse().setHeader("Content-Type", "text/event-stream").setHeader("x-vercel-ai-ui-message-stream", "v1").setBody("data: {\"type\":\"start\",\"messageId\":\"assistant\"}\n\n")
                        else -> MockResponse().setBody(page(active = !cancelled))
                    }
                }
            }
            val first = ConversationSession(client(server), "alice", store = MemoryConversationOutboxStore(), scope = scope)
            first.refresh(); first.close(); assertFalse(paths.any { it.endsWith("/cancel") })
            val second = ConversationSession(client(server), "alice", store = MemoryConversationOutboxStore(), scope = scope)
            second.refresh(); second.cancel(); assertTrue(paths.any { it.endsWith("/cancel") }); assertFalse(second.state.value.busy); second.close()
        } finally { scope.cancel(); server.shutdown() }
    }
    @Test fun retryWithoutPendingCommandRecoversHistoryInsteadOfPostingAgain() = runBlocking {
        val server = MockWebServer(); server.start(); val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val session = ConversationSession(client(server), "alice", store = MemoryConversationOutboxStore(), scope = scope)
            server.enqueue(MockResponse().setResponseCode(503)); session.refresh()
            assertNotNull(session.state.value.error)
            server.enqueue(MockResponse().setBody(page(message("assistant", "assistant", 1, "Recovered"))))
            session.retryPending()
            assertEquals("Recovered", session.state.value.messages.single().text)
            assertNull(session.state.value.error)
            assertEquals("GET", server.takeRequest().method); assertEquals("GET", server.takeRequest().method)
            session.close()
        } finally { scope.cancel(); server.shutdown() }
    }
    @Test fun pendingCommandCannotBeOverwrittenAndAccountMismatchCannotSend() = runBlocking {
        val server = MockWebServer(); server.start(); val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val store = MemoryConversationOutboxStore(); val original = OutboxEntry(PendingMessage("alice", MessageCommand.create("Original"))); store.save(original)
            val session = ConversationSession(client(server), "alice", store = store, scope = scope)
            try { session.send("Replacement"); fail("Expected unresolved-message protection") } catch (_: IllegalStateException) {}
            assertEquals(original, store.load("alice", null)); assertEquals(0, server.requestCount); session.close()
            try { PendingMessage("bob", MessageCommand.create("Private")).send(client(server)); fail("Expected ownership rejection") } catch (_: AccountChangedException) {}
            assertEquals(0, server.requestCount)
        } finally { scope.cancel(); server.shutdown() }
    }
}
