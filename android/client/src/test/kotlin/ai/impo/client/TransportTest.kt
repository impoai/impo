package ai.impo.client

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.toList
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class TransportTest {
    private lateinit var server: MockWebServer
    @Before fun setUp() { server = MockWebServer(); server.start() }
    @After fun tearDown() { server.shutdown() }
    private fun client(provider: TokenProvider = StaticTokenProvider("token-a", "a"), prefix: String = "") = ImpoClient(server.url(prefix).toString(), provider, true,
        OkHttpClient.Builder().retryOnConnectionFailure(false).readTimeout(2, TimeUnit.SECONDS).build())
    private val receipt = """{"messageId":"user","submissionId":"run"}"""
    private val page = """{"conversationId":"main","messages":[],"activeSubmissions":[],"hasMore":false,"nextAfterSequence":0,"future":true}"""
    @Test fun prefixBodyAndIdsAreStableAcrossAuthenticationRetry() = runBlocking {
        val refreshes = AtomicInteger()
        val provider = object : TokenProvider {
            var current = SessionToken("a", "old")
            override suspend fun token() = current
            override suspend fun refresh(rejected: SessionToken): SessionToken { refreshes.incrementAndGet(); current = SessionToken("a", "fresh"); return current }
        }
        server.enqueue(MockResponse().setResponseCode(401)); server.enqueue(MockResponse().setResponseCode(202).setBody(receipt))
        val command = MessageCommand.create("hello")
        assertEquals("run", client(provider, "/instant/").sendMessage(command, "device").submissionId)
        val first = server.takeRequest(); val second = server.takeRequest()
        assertEquals("/instant/api/v1/conversation/messages", first.path)
        assertEquals(first.body.readUtf8(), second.body.readUtf8())
        assertEquals("Bearer old", first.getHeader("Authorization")); assertEquals("Bearer fresh", second.getHeader("Authorization"))
        assertEquals(1, refreshes.get())
    }
    @Test fun concurrentUnauthorizedResponsesCoordinateRefresh() = runBlocking {
        val refreshes = AtomicInteger()
        val provider = object : TokenProvider {
            @Volatile var current = SessionToken("a", "old")
            override suspend fun token() = current
            override suspend fun refresh(rejected: SessionToken): SessionToken { delay(50); refreshes.incrementAndGet(); current = SessionToken("a", "fresh"); return current }
        }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = if (request.getHeader("Authorization") == "Bearer old") MockResponse().setResponseCode(401) else MockResponse().setBody(page)
        }
        val client = client(provider)
        (1..8).map { async(Dispatchers.Default) { client.conversation() } }.awaitAll()
        assertEquals(1, refreshes.get())
    }
    @Test fun second401IsNotRetriedForeverAndStructuredErrorsArePreserved() = runBlocking {
        repeat(2) { server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"signed_out","message":"Sign in","retryable":false},"requestId":"req"}""")) }
        val error = try { client().conversation(); null } catch (error: ApiException) { error }
        assertEquals(401, error!!.statusCode); assertEquals("signed_out", error.code); assertEquals("req", error.requestId)
        assertEquals(2, server.requestCount)
    }
    @Test fun accountChangeDuringRefreshCannotResendUnderAnotherIdentity() = runBlocking {
        val provider = object : TokenProvider {
            override suspend fun token() = SessionToken("a", "old")
            override suspend fun refresh(rejected: SessionToken) = SessionToken("b", "new")
        }
        server.enqueue(MockResponse().setResponseCode(401))
        try { client(provider).sendMessage(MessageCommand.create("private")); fail("Expected account isolation") } catch (_: AccountChangedException) {}
        assertEquals(1, server.requestCount)
    }
    @Test fun oneClientCannotBeReusedAcrossAccounts() = runBlocking {
        val provider = object : TokenProvider {
            var account = "a"
            override suspend fun token() = SessionToken(account, "token-$account")
            override suspend fun refresh(rejected: SessionToken) = token()
        }
        val client = client(provider); server.enqueue(MockResponse().setBody(page)); client.conversation(); provider.account = "b"
        try { client.conversation(); fail("Expected account isolation") } catch (_: AccountChangedException) {}
        assertEquals(1, server.requestCount)
    }
    @Test fun userBTransportNeverSuppliesUserAResourceOwnership() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"Not found"}}"""))
        try { client(StaticTokenProvider("b-token", "b")).taskConversation("a-owned-task"); fail("Expected not found") } catch (error: ApiException) { assertEquals(404, error.statusCode) }
        val request = server.takeRequest()
        assertEquals("Bearer b-token", request.getHeader("Authorization")); assertFalse(request.body.readUtf8().contains("userId"))
    }
    @Test fun applicationRedirectsNeverLeakBearerCredentials() = runBlocking {
        val other = MockWebServer(); other.start()
        try {
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", other.url("/steal")))
            try { client().conversation(); fail("Expected redirect failure") } catch (error: ApiException) { assertEquals(302, error.statusCode) }
            assertEquals(0, other.requestCount)
        } finally { other.shutdown() }
    }
    @Test fun signedUploadUsesExactBytesAndNoBearerAndDoesNotFollowRedirects() = runBlocking {
        val other = MockWebServer(); other.start()
        try {
            val client = client(); val bytes = "{\"audio\":\"👋\"}".toByteArray()
            server.enqueue(MockResponse().setResponseCode(200))
            client.uploadAudio(UploadTicket("upload", server.url("/signed?secret=signature").toString(), mapOf("Content-Type" to "application/json")), bytes)
            val request = server.takeRequest(); assertArrayEquals(bytes, request.body.readByteArray()); assertNull(request.getHeader("Authorization"))
            server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", other.url("/steal")))
            try { client.uploadAudio(UploadTicket("upload", server.url("/signed").toString()), bytes); fail("Expected redirect failure") } catch (error: ApiException) { assertEquals(307, error.statusCode) }
            assertEquals(0, other.requestCount)
            try { client.uploadAudio(UploadTicket("upload", server.url("/signed").toString(), mapOf("Authorization" to "Bearer nope")), bytes); fail("Expected unsafe ticket rejection") } catch (_: ProtocolException) {}
        } finally { other.shutdown() }
    }
    @Test fun invalidStreamHeadersAndTruncationFailWithoutCancelCommand() = runBlocking {
        server.enqueue(MockResponse().setHeader("Content-Type", "text/html").setBody("no"))
        try { client().streamSubmission("run").toList(); fail("Expected wrong stream") } catch (_: ProtocolException) {}
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setHeader("x-vercel-ai-ui-message-stream", "v1").setBody("data: {\"type\":\"start\",\"messageId\":\"a\"}\n\n"))
        try { client().streamSubmission("run").toList(); fail("Expected incomplete stream") } catch (_: ProtocolException) {}
        repeat(2) { assertEquals("GET", server.takeRequest().method) }
    }
    @Test fun safeReadsRecoverAClosedReusedConnectionWithoutChangingAuthorization() = runBlocking {
        val client = client()
        server.enqueue(MockResponse().setBody("{\"connectors\":[]}"))
        assertTrue(client.connectors().isEmpty()) // Establish the keep-alive connection.
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        server.enqueue(MockResponse().setBody("{\"connectors\":[{\"toolkit\":\"gmail\",\"name\":\"Gmail\",\"status\":\"connected\"}]}"))
        assertEquals("connected", client.connectors().single().status)
        val requests = (1..3).map { server.takeRequest() }
        assertTrue(requests.all { it.method == "GET" && it.path == "/api/v1/connectors" })
        assertTrue(requests.all { it.getHeader("Authorization") == "Bearer token-a" })
        assertTrue(requests[1].sequenceNumber > 0)
    }
    @Test fun oauthConnectIsNeverTransparentlyRetriedAfterALostResponse() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        try { client().connectConnector("gmail"); fail("The uncertain OAuth command must surface its lost response") }
        catch (_: java.io.IOException) {}
        assertEquals(1, server.requestCount)
        assertEquals("POST", server.takeRequest().method)
    }

    @Test fun successfulConnectorRefreshesAndCompletedStreamsNeverCancelPooledCalls() = runBlocking {
        val cancelled = AtomicInteger()
        val http = OkHttpClient.Builder().eventListener(object : EventListener() {
            override fun canceled(call: Call) { cancelled.incrementAndGet() }
        }).build()
        val client = ImpoClient(server.url("/").toString(), StaticTokenProvider("token", "alice"), true, http)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path!!.endsWith("/stream") -> MockResponse().setHeader("Content-Type", "text/event-stream")
                    .setHeader("x-vercel-ai-ui-message-stream", "v1")
                    .setBody("data: {\"type\":\"start\",\"messageId\":\"assistant\"}\n\ndata: {\"type\":\"finish\"}\n\ndata: [DONE]\n\n")
                request.path!!.endsWith("/refresh") -> MockResponse().setBody("{\"status\":\"connected\"}")
                else -> MockResponse().setBody("{\"connectors\":[]}")
            }
        }
        repeat(10) {
            assertTrue(client.connectors().isEmpty())
            assertEquals("connected", client.refreshConnector("gmail").status)
        }
        (1..8).map { async(Dispatchers.Default) {
            assertTrue(client.connectors().isEmpty())
            assertEquals("connected", client.refreshConnector("gmail").status)
        } }.awaitAll()
        assertTrue(client.streamSubmission("run").toList().last().done)
        assertTrue(client.connectors().isEmpty())
        assertEquals("Completing a body or stream must not cancel a successful call", 0, cancelled.get())
        val requests = (1..38).map { server.takeRequest() }
        assertTrue("The regression must exercise actual keep-alive connection reuse", requests.any { it.sequenceNumber > 0 })
    }

    @Test fun cancellationInterruptsAnOpenStreamWithoutCancellingServerRun() = runBlocking {
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setHeader("x-vercel-ai-ui-message-stream", "v1")
            .setBody("data: {\"type\":\"start\",\"messageId\":\"a\"}\n\n").setHeader("Content-Length", "100000"))
        val observed = CompletableDeferred<Unit>()
        val subscription = launch { client().streamSubmission("run").collect { observed.complete(Unit) } }
        withTimeout(3000) { observed.await() }
        withTimeout(1000) { subscription.cancelAndJoin() }
        assertEquals(1, server.requestCount)
    }
    @Test fun errorsAndEmptyPagesAreDistinctAndUnknownFieldsAreTolerated() = runBlocking {
        server.enqueue(MockResponse().setBody(page)); assertTrue(client().conversation().messages.isEmpty())
        server.enqueue(MockResponse().setResponseCode(503).setHeader("Retry-After", "7").setBody("proxy unavailable"))
        try { client().conversation(); fail("Expected unavailable") } catch (error: ApiException) { assertEquals(503, error.statusCode); assertEquals("7", error.retryAfter); assertTrue(error.retryable) }
    }
    @Test fun explicitNullLocationAndLabelsAreNotOmitted() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"settings":{"timeZone":"UTC","locale":"en","displayName":"","slots":[]}}"""))
        client().updateBriefSettings(BriefSettings("UTC", "en"))
        assertEquals(JsonNull, ProtocolJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject["location"])
    }
    @Test fun insecurePublicUrlsAndCredentialUrlsAreRejected() {
        for (url in listOf("http://api.example.com", "https://user:secret@example.com", "https://example.com?token=secret")) {
            try { ImpoClient(url, StaticTokenProvider("token"), true); fail("Expected URL rejection") } catch (_: IllegalArgumentException) {}
        }
    }
}
