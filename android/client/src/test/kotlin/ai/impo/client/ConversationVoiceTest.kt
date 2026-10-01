package ai.impo.client

import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class ConversationVoiceTest {
    private val clip = VoiceClip.fromBytes(byteArrayOf(0, 1, -1, 42), "audio/mp4")
    private val transcript = "你好 👋 — remember this"
    private val receipt = ProtocolJson.encodeToString(VoiceMessageReceipt("user-voice", "run-voice", transcript))
    private val run = """{"submissionId":"run-voice","messageId":"assistant","status":"completed"}"""
    private fun page(includeVoice: Boolean = false) = ProtocolJson.encodeToString(ConversationPage("main",
        if (includeVoice) listOf(ConversationMessage("user-voice", "user", 1, transcript, "completed", "2026-10-01T00:00:00.000Z")) else emptyList()))
    private fun client(server: MockWebServer, provider: TokenProvider = StaticTokenProvider("alice-token", "alice")) =
        ImpoClient(server.url("/").toString(), provider, true, OkHttpClient.Builder().readTimeout(2, TimeUnit.SECONDS).build())

    @Test fun lostAdmissionAndLaterProcessRestartsPreserveExactClipThenRecoverWithoutAnotherPost() = runBlocking {
        val directory = Files.createTempDirectory("impo-voice-outbox").toFile()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        MockWebServer().use { server ->
            try {
                val posted = CopyOnWriteArrayList<String>()
                val calls = AtomicInteger()
                val recover = AtomicBoolean(false)
                server.dispatcher = object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse = when {
                        request.path == "/api/v1/conversation/voice-messages" -> {
                            posted += request.body.readUtf8()
                            if (calls.incrementAndGet() == 1) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                            else MockResponse().setResponseCode(202).setBody(receipt)
                        }
                        request.path == "/api/v1/submissions/run-voice" -> if (recover.get()) MockResponse().setBody(run) else MockResponse().setResponseCode(503)
                        request.path!!.startsWith("/api/v1/conversation?") -> MockResponse().setBody(page(includeVoice = recover.get()))
                        else -> MockResponse().setResponseCode(404)
                    }
                }
                var store = FileConversationOutboxStore(directory)
                val first = ConversationSession(client(server), "alice", store = store, scope = scope, deviceId = { "frozen-device" })
                assertTrue(first.sendVoice(clip)) // Local admission succeeded despite the lost response.
                val original = store.load("alice", null)!!
                assertEquals(clip.audio, original.voice!!.command.audio)
                assertEquals("frozen-device", original.voice!!.deviceId)
                assertNull(original.receipt)
                assertFalse(first.state.value.pendingVoice!!.transcribing)
                assertNotNull(first.state.value.error)
                assertNull(store.load("bob", null)); assertNull(store.load("alice", "task"))
                first.close()

                store = FileConversationOutboxStore(directory)
                val second = ConversationSession(client(server), "alice", store = store, scope = scope, deviceId = { "new-device-must-not-be-used" })
                second.refresh()
                assertEquals(original.clientMessageId, second.state.value.pendingVoice!!.clientMessageId)
                second.retryPending()
                assertEquals(2, posted.size)
                assertEquals(posted[0], posted[1])
                assertEquals(transcript, second.state.value.messages.single().text)
                assertNull(second.state.value.pendingVoice)
                val accepted = store.load("alice", null)!!
                assertEquals(transcript, accepted.acceptedVoiceText)
                assertEquals("user-voice", accepted.receipt!!.messageId)
                second.close()

                recover.set(true)
                store = FileConversationOutboxStore(directory)
                val third = ConversationSession(client(server), "alice", store = store, scope = scope)
                third.retryPending()
                withTimeout(3000) { while (third.state.value.hasPendingMessage) delay(10) }
                assertEquals(2, posted.size)
                assertEquals(listOf(transcript), third.state.value.messages.map { it.text })
                assertNull(store.load("alice", null))
                assertTrue(directory.listFiles()!!.isEmpty()) // Bytes are removed only after owned history confirms receipt.
                third.close()
            } finally { scope.cancel(); directory.deleteRecursively() }
        }
    }

    @Test fun pendingBubbleAppearsBeforeResponseAndAcceptedTextUsesServerIdentity() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        MockWebServer().use { server ->
            try {
                server.enqueue(MockResponse().setResponseCode(202).setBody(receipt).setBodyDelay(200, TimeUnit.MILLISECONDS))
                server.enqueue(MockResponse().setResponseCode(503)) // Keep acceptance durable while recovery is temporarily unavailable.
                val store = MemoryConversationOutboxStore()
                val session = ConversationSession(client(server), "alice", store = store, scope = scope)
                val sending = async(Dispatchers.Default) { session.sendVoice(clip) }
                assertNotNull(withContext(Dispatchers.IO) { server.takeRequest(2, TimeUnit.SECONDS) })
                assertTrue(session.state.value.pendingVoice!!.transcribing)
                assertTrue(session.state.value.busy)
                assertTrue(session.state.value.messages.isEmpty())
                assertNotNull(store.load("alice", null)?.voice)
                assertTrue(sending.await())
                assertNull(session.state.value.pendingVoice)
                assertEquals("user-voice", session.state.value.messages.single().id)
                assertEquals(transcript, session.state.value.messages.single().text)
                assertEquals("run-voice", session.state.value.activeSubmissionId)
                session.close()
            } finally { scope.cancel() }
        }
    }

    @Test fun emptyTranscriptDropsOnlyRejectedClipAndAllowsANewIdentity() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        MockWebServer().use { server ->
            try {
                server.enqueue(MockResponse().setResponseCode(422).setBody("""{"error":{"code":"empty_transcript","message":"No speech heard","retryable":false}}"""))
                val store = MemoryConversationOutboxStore()
                val session = ConversationSession(client(server), "alice", store = store, scope = scope)
                assertTrue(session.sendVoice(clip))
                val rejected = ProtocolJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject.getValue("clientMessageId")
                assertNull(store.load("alice", null)); assertNull(session.state.value.pendingVoice)
                assertFalse(session.state.value.hasPendingMessage); assertFalse(session.state.value.busy)
                assertEquals("No speech heard", session.state.value.error)
                server.enqueue(MockResponse().setResponseCode(503))
                assertTrue(session.sendVoice(clip))
                val replacement = ProtocolJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject.getValue("clientMessageId")
                assertNotEquals(rejected, replacement)
                assertNotNull(store.load("alice", null)?.voice)
                session.close()
            } finally { scope.cancel() }
        }
    }

    @Test fun offlineHistoryStillRestoresThePendingClipAndDoesNotAuthorizeReplacement() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        MockWebServer().use { server ->
            try {
                val store = MemoryConversationOutboxStore()
                val pending = OutboxEntry(voice = PendingVoiceMessage("alice", VoiceMessageCommand.create(clip)))
                store.save(pending)
                server.enqueue(MockResponse().setResponseCode(503))
                val session = ConversationSession(client(server), "alice", store = store, scope = scope)
                session.refresh()
                assertEquals(pending.clientMessageId, session.state.value.pendingVoice!!.clientMessageId)
                assertFalse(session.state.value.pendingVoice!!.transcribing)
                assertFalse(session.sendVoice(VoiceClip.fromBytes(byteArrayOf(42), "audio/wav")))
                assertEquals(pending, store.load("alice", null))
                assertEquals(1, server.requestCount)
                session.close()
            } finally { scope.cancel() }
        }
    }

    @Test fun taskConversationDeclinesVoiceAdmissionWithoutAFileOrHttpMutation() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        MockWebServer().use { server ->
            try {
                val store = MemoryConversationOutboxStore()
                val session = ConversationSession(client(server), "alice", "task", store, scope)
                assertFalse(session.sendVoice(clip))
                assertNull(store.load("alice", "task")); assertNull(store.load("alice", null))
                assertEquals(0, server.requestCount)
                session.close()
            } finally { scope.cancel() }
        }
    }

    @Test fun acceptedTranscriptStaysVisibleWhileHistoryLagsAndAudioWaitsForConfirmation() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        MockWebServer().use { server ->
            try {
                val store = MemoryConversationOutboxStore()
                val accepted = OutboxEntry(voice = PendingVoiceMessage("alice", VoiceMessageCommand.create(clip)),
                    receipt = MessageReceipt("user-voice", "run-voice"), acceptedVoiceText = transcript)
                store.save(accepted)
                server.enqueue(MockResponse().setBody(page()))
                server.enqueue(MockResponse().setBody(run))
                val session = ConversationSession(client(server), "alice", store = store, scope = scope)
                session.refresh()
                assertEquals(transcript, session.state.value.messages.single().text)
                assertEquals(accepted, store.load("alice", null))
                assertTrue(session.state.value.hasPendingMessage)
                assertNull(session.state.value.pendingVoice)
                server.enqueue(MockResponse().setBody(page(includeVoice = true)))
                session.refresh()
                assertNull(store.load("alice", null))
                assertFalse(session.state.value.hasPendingMessage)
                repeat(3) { assertEquals("GET", server.takeRequest().method) }
                session.close()
            } finally { scope.cancel() }
        }
    }

    @Test fun sessionClosedDuringDeviceLookupCannotPersistOrSendTheClip() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        MockWebServer().use { server ->
            try {
                val deviceLookup = CompletableDeferred<Unit>()
                val store = MemoryConversationOutboxStore()
                val session = ConversationSession(client(server), "alice", store = store, scope = scope, deviceId = {
                    deviceLookup.complete(Unit)
                    awaitCancellation()
                })
                val sending = async(Dispatchers.Default) { session.sendVoice(clip) }
                withTimeout(1000) { deviceLookup.await() }
                session.close()
                withTimeout(1000) { sending.join() }
                assertTrue(sending.isCancelled)
                assertNull(store.load("alice", null))
                assertEquals(0, server.requestCount)
            } finally { scope.cancel() }
        }
    }

    @Test fun preVoiceTextOutboxSchemaStillRestoresTheOriginalCommand() {
        val oldJson = """{"pending":{"accountId":"alice","command":{"clientMessageId":"old-id","text":"Original text"},"deviceId":"device"},"receipt":{"messageId":"user","submissionId":"run"}}"""
        val restored = ProtocolJson.decodeFromString<OutboxEntry>(oldJson)
        assertEquals("Original text", restored.pending!!.command.text)
        assertEquals("old-id", restored.clientMessageId)
        assertEquals("alice", restored.accountId)
        assertEquals("user", restored.receipt!!.messageId)
        assertNull(restored.voice)
    }

    @Test fun closingTheLoginCancelsAdmissionSubscriptionButKeepsTheExactUncertainClip() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        MockWebServer().use { server ->
            try {
                server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
                val store = MemoryConversationOutboxStore()
                val session = ConversationSession(client(server), "alice", store = store, scope = scope)
                val sending = async(Dispatchers.Default) { session.sendVoice(clip) }
                val request = withContext(Dispatchers.IO) { server.takeRequest(2, TimeUnit.SECONDS) }
                assertNotNull(request)
                val pending = store.load("alice", null)!!
                session.close()
                withTimeout(1500) { sending.join() }
                assertTrue(sending.isCancelled)
                assertEquals(pending, store.load("alice", null))
                assertEquals(1, server.requestCount)
                assertEquals("/api/v1/conversation/voice-messages", request!!.path)
                try { session.retryPending(); fail("A closed login must not retry") } catch (_: CancellationException) { }
                assertTrue(scope.isActive) // Closing a conversation never cancels its owner's entire scope.
            } finally { scope.cancel() }
        }
    }

    @Test fun receiptFromReplacedLoginCannotClearOrAcknowledgeTheNewSessionOutbox() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        MockWebServer().use { server ->
            try {
                val current = AtomicBoolean(true)
                val provider = object : TokenProvider {
                    override suspend fun token(): SessionToken {
                        if (!current.get()) throw AccountChangedException()
                        return SessionToken("alice", "old-session")
                    }
                    override suspend fun refresh(rejected: SessionToken) = token()
                }
                server.enqueue(MockResponse().setResponseCode(202).setBody(receipt).setBodyDelay(150, TimeUnit.MILLISECONDS))
                val store = MemoryConversationOutboxStore()
                val old = ConversationSession(client(server, provider), "alice", store = store, scope = scope)
                val sending = async(Dispatchers.Default) { old.sendVoice(clip) }
                assertNotNull(withContext(Dispatchers.IO) { server.takeRequest(2, TimeUnit.SECONDS) })
                current.set(false)
                val replacement = OutboxEntry(voice = PendingVoiceMessage("alice", VoiceMessageCommand.create(clip)))
                store.save(replacement)
                try { sending.await(); fail("Old login should be fenced") } catch (_: AccountChangedException) { }
                assertEquals(replacement, store.load("alice", null))
                assertTrue(old.state.value.messages.isEmpty())
                assertEquals(1, server.requestCount)
                old.close()
            } finally { scope.cancel() }
        }
    }
}
