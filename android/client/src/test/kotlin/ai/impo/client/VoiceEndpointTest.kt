package ai.impo.client

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.util.Base64
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class VoiceEndpointTest {
    private val audio = byteArrayOf(0, 1, -1, 42)
    private val receipt = """{"messageId":"user-voice","submissionId":"run-voice","text":"你好 👋 — hello","future":true}"""
    private fun client(server: MockWebServer, provider: TokenProvider = StaticTokenProvider("secret", "alice")) =
        ImpoClient(server.url("/instant").toString(), provider, true, OkHttpClient.Builder().readTimeout(2, TimeUnit.SECONDS).build())

    @Test fun clipIsImmutableCanonicalAndEnforcesTheDecodedTwoMiBLimit() {
        val source = audio.copyOf()
        val clip = VoiceClip.fromBytes(source, "audio/mp4")
        source.fill(9)
        assertArrayEquals(audio, Base64.getDecoder().decode(clip.audio))
        val maximum = VoiceClip.fromBytes(ByteArray(VoiceClip.MAX_BYTES), "audio/wav")
        assertEquals(VoiceClip.MAX_BYTES, Base64.getDecoder().decode(maximum.audio).size)
        assertThrows(IllegalArgumentException::class.java) { VoiceClip.fromBytes(ByteArray(VoiceClip.MAX_BYTES + 1), "audio/mp4") }
        assertThrows(IllegalArgumentException::class.java) { VoiceClip.fromBytes(byteArrayOf(), "audio/mp4") }
        assertThrows(IllegalArgumentException::class.java) { VoiceClip.fromBytes(audio, "text/plain") }
        assertThrows(IllegalArgumentException::class.java) { VoiceClip("YQ", "audio/mp4") }
        assertThrows(IllegalArgumentException::class.java) { VoiceClip("YQ==\n", "audio/mp4") }
        for (mime in listOf("audio/mp4", "audio/m4a", "audio/aac", "audio/mpeg", "audio/wav", "audio/ogg", "audio/webm", "audio/flac"))
            assertEquals(mime, VoiceClip.fromBytes(audio, mime).mimeType)
        assertFalse(clip.toString().contains(clip.audio))
    }

    @Test fun atomicAdmissionUsesFrozenAudioContextAndDeviceAcrossAuthRefresh() = runBlocking {
        MockWebServer().use { server ->
            val provider = object : TokenProvider {
                var current = SessionToken("alice", "old")
                override suspend fun token() = current
                override suspend fun refresh(rejected: SessionToken): SessionToken { current = SessionToken("alice", "new"); return current }
            }
            server.enqueue(MockResponse().setResponseCode(401))
            server.enqueue(MockResponse().setResponseCode(202).setBody(receipt))
            val command = VoiceMessageCommand.create(VoiceClip.fromBytes(audio, "audio/mp4"), "Asia/Shanghai", Instant.parse("2026-10-01T01:02:03.123456Z"))
            val result = client(server, provider).sendVoiceMessage(command, "device")
            assertEquals("你好 👋 — hello", result.text)
            val first = server.takeRequest(); val second = server.takeRequest()
            val exact = first.body.readUtf8()
            assertEquals(exact, second.body.readUtf8())
            assertEquals("POST", first.method)
            assertEquals("/instant/api/v1/conversation/voice-messages", first.path)
            assertEquals("Bearer old", first.getHeader("Authorization"))
            assertEquals("Bearer new", second.getHeader("Authorization"))
            val body = ProtocolJson.parseToJsonElement(exact).jsonObject
            assertEquals(setOf("clientMessageId", "audio", "mimeType", "clientContext", "deviceId"), body.keys)
            assertEquals(command.clientMessageId, body.getValue("clientMessageId").jsonPrimitive.content)
            assertArrayEquals(audio, Base64.getDecoder().decode(body.getValue("audio").jsonPrimitive.content))
            assertEquals("2026-10-01T01:02:03.123Z", body.getValue("clientContext").jsonObject.getValue("currentDate").jsonPrimitive.content)
        }
    }

    @Test fun draftTranscriptionHasNoAdmissionOrDeviceFieldsAndPreservesProviderErrors() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"text":"创建一个任务 🦊"}"""))
            val client = client(server)
            assertEquals("创建一个任务 🦊", client.transcribeVoice(VoiceClip.fromBytes(audio, "audio/mp4")))
            val request = server.takeRequest()
            assertEquals("/instant/api/v1/voice/transcriptions", request.path)
            assertEquals(setOf("audio", "mimeType"), ProtocolJson.parseToJsonElement(request.body.readUtf8()).jsonObject.keys)
            server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":{"code":"transcription_unavailable","message":"Try again","retryable":true}}"""))
            try { client.transcribeVoice(VoiceClip.fromBytes(audio, "audio/mp4")); fail("Expected provider failure") }
            catch (error: ApiException) { assertEquals("transcription_unavailable", error.code); assertTrue(error.retryable) }
            assertEquals(2, server.requestCount) // Mutations have no implicit network retry.
        }
    }

    @Test fun malformedAcceptanceNeverProvidesAUsableReceipt() = runBlocking {
        MockWebServer().use { server ->
            val client = client(server)
            for (body in listOf("""{"messageId":"user","submissionId":"run"}""", """{"messageId":"user","submissionId":"run","text":" "}""", """{"messageId":"","submissionId":"run","text":"Hello"}""")) {
                server.enqueue(MockResponse().setResponseCode(202).setBody(body))
                try { client.sendVoiceMessage(VoiceMessageCommand.create(VoiceClip.fromBytes(audio, "audio/mp4"))); fail("Expected malformed receipt") }
                catch (_: ProtocolException) { }
            }
            server.enqueue(MockResponse().setBody("""{"text":""}"""))
            try { client.transcribeVoice(VoiceClip.fromBytes(audio, "audio/mp4")); fail("Expected invalid draft") }
            catch (_: ProtocolException) { }
        }
    }

    @Test fun cancellingDraftInterruptsItsHttpCallWithoutAcceptingOrCancellingAnyRun() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val client = client(server)
            val draft = async(Dispatchers.Default) { client.transcribeVoice(VoiceClip.fromBytes(audio, "audio/mp4")) }
            val request = withContext(Dispatchers.IO) { server.takeRequest(2, TimeUnit.SECONDS) }
            assertNotNull(request)
            withTimeout(1500) { draft.cancelAndJoin() }
            assertTrue(draft.isCancelled)
            assertEquals("/instant/api/v1/voice/transcriptions", request!!.path)
            assertEquals(1, server.requestCount)
        }
    }

    @Test fun oldLoginCannotReturnACompletedTranscriptAfterSessionReplacement() = runBlocking {
        MockWebServer().use { server ->
            val currentLogin = AtomicBoolean(true)
            val provider = object : TokenProvider {
                override suspend fun token(): SessionToken {
                    if (!currentLogin.get()) throw AccountChangedException()
                    return SessionToken("alice", "same-user-first-login")
                }
                override suspend fun refresh(rejected: SessionToken) = token()
            }
            server.enqueue(MockResponse().setBody("""{"text":"Private old draft"}""").setBodyDelay(150, TimeUnit.MILLISECONDS))
            val client = client(server, provider)
            val draft = async(Dispatchers.Default) { client.transcribeVoice(VoiceClip.fromBytes(audio, "audio/mp4")) }
            assertNotNull(withContext(Dispatchers.IO) { server.takeRequest(2, TimeUnit.SECONDS) })
            currentLogin.set(false)
            try { draft.await(); fail("Old login returned its transcript") } catch (_: AccountChangedException) { }
            assertTrue(draft.isCancelled)
        }
    }
}
