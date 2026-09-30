package ai.impo.client

import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.IOException
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

class DurabilityTest {
    @get:Rule val temporary = TemporaryFolder()
    private fun batch() = SealedBatch(UUID.randomUUID().toString(), UUID.randomUUID().toString(), 1, UUID.randomUUID().toString(), listOf(
        AudioItem(UUID.randomUUID().toString(), "2026-09-30T01:00:00Z", "2026-09-30T01:00:01Z", "audio/mp4", "AQID")))
    private fun accepted(batch: SealedAudioUpload) = BatchReceipt(batch.manifest.batch.batchId, batch.manifest.batch.streamId, batch.manifest.batch.sequence, "accepted")
    @Test fun messageClockContextUsesServerSupportedMillisecondPrecision() {
        val command = MessageCommand.create("Hello", "UTC", Instant.parse("2026-09-30T00:00:00.123456789Z"))
        assertEquals("2026-09-30T00:00:00.123Z", command.clientContext!!.currentDate)
        assertEquals("2026-09-30T00:00:00.000Z", wireTimestamp(Instant.parse("2026-09-30T00:00:00Z")))
    }
    @Test fun sealedBytesHashAndManifestStayImmutableAcrossRestore() {
        val source = batch(); val sealed = SealedAudioUpload.create("alice", source)
        val bytes = sealed.bytes; bytes.fill(0)
        val restored = SealedAudioUpload.restore("alice", sealed.bytes)
        assertEquals(sealed.manifest, restored.manifest)
        assertEquals(3, restored.manifest.batch.items.single().audioBytes)
        assertEquals(64, restored.manifest.sha256.length)
        assertEquals(sealed.bytes.size, restored.manifest.byteLength)
        val canonical = source.copy(items = source.items.map { it.copy(startedAt = "2026-09-30T01:00:00.000Z", endedAt = "2026-09-30T01:00:01.000Z") })
        assertEquals(ProtocolJson.encodeToString(canonical), sealed.bytes.toString(Charsets.UTF_8))
    }
    @Test fun mismatchOrUnknownReceiptCannotAuthorizeCleanup() {
        val sealed = SealedAudioUpload.create("alice", batch()); val receipt = accepted(sealed)
        sealed.validateMatchingReceipt(receipt)
        for (invalid in listOf(receipt.copy(batchId = "other"), receipt.copy(streamId = "other"), receipt.copy(sequence = 2), receipt.copy(status = "uploaded"))) {
            try { sealed.validateMatchingReceipt(invalid); fail("Expected receipt rejection") } catch (_: ProtocolException) {}
        }
    }
    @Test fun noncanonicalBase64DuplicateIdsAndBadDurationsCannotBeSealed() {
        val batch = batch(); val item = batch.items.single()
        for (invalid in listOf(batch.copy(items = listOf(item.copy(audio = "AQI"))), batch.copy(items = listOf(item, item)), batch.copy(items = listOf(item.copy(endedAt = item.startedAt))))) {
            try { SealedAudioUpload.create("alice", invalid); fail("Expected invalid batch") } catch (_: IllegalArgumentException) {}
        }
    }
    @Test fun persistedAcknowledgmentPrecedesRemovalAndFailureRetainsBytes() = runBlocking {
        val server = MockWebServer(); server.start()
        try {
            val sealed = SealedAudioUpload.create("alice", batch()); val receipt = accepted(sealed)
            val events = mutableListOf<String>()
            val client = ImpoClient(server.url("/").toString(), StaticTokenProvider("a", "alice"), true)
            val store = object : UploadAcknowledgmentStore {
                override suspend fun persistAcknowledgment(accountId: String, receipt: BatchReceipt) { events += "persist"; throw IOException("Disk full") }
                override suspend fun removeAcknowledgedBytes(accountId: String, batchId: String) { events += "remove" }
            }
            server.enqueue(MockResponse().setBody(ProtocolJson.encodeToString(UploadTicket("accepted", receipt = receipt))))
            try { AudioUploadCoordinator(client, store).upload(sealed); fail("Expected durability failure") } catch (_: IOException) {}
            assertEquals(listOf("persist"), events)
            val successStore = object : UploadAcknowledgmentStore {
                override suspend fun persistAcknowledgment(accountId: String, receipt: BatchReceipt) { events += "saved" }
                override suspend fun removeAcknowledgedBytes(accountId: String, batchId: String) { events += "removed" }
            }
            server.enqueue(MockResponse().setBody(ProtocolJson.encodeToString(UploadTicket("accepted", receipt = receipt))))
            AudioUploadCoordinator(client, successStore).upload(sealed)
            assertEquals(listOf("persist", "saved", "removed"), events)
        } finally { server.shutdown() }
    }
    @Test fun uploadCannotCrossAccountBoundary() = runBlocking {
        val server = MockWebServer(); server.start()
        try {
            val store = object : UploadAcknowledgmentStore {
                override suspend fun persistAcknowledgment(accountId: String, receipt: BatchReceipt) { fail("No write allowed") }
                override suspend fun removeAcknowledgedBytes(accountId: String, batchId: String) { fail("No cleanup allowed") }
            }
            val client = ImpoClient(server.url("/").toString(), StaticTokenProvider("b", "bob"), true)
            try { AudioUploadCoordinator(client, store).upload(SealedAudioUpload.create("alice", batch())); fail("Expected ownership rejection") } catch (_: AccountChangedException) {}
            assertEquals(0, server.requestCount)
        } finally { server.shutdown() }
    }
    @Test fun lostConfirmationRetriesUnchangedManifestAndSkipsAlreadyUploadedBytes() = runBlocking {
        val server = MockWebServer(); server.start()
        try {
            val sealed = SealedAudioUpload.create("alice", batch()); val receipt = accepted(sealed)
            var persisted = false; var removed = false
            val store = object : UploadAcknowledgmentStore {
                override suspend fun persistAcknowledgment(accountId: String, receipt: BatchReceipt) { persisted = true }
                override suspend fun removeAcknowledgedBytes(accountId: String, batchId: String) { assertTrue(persisted); removed = true }
            }
            server.enqueue(MockResponse().setBody("""{"status":"uploaded"}"""))
            server.enqueue(MockResponse().setResponseCode(503).setBody("unavailable"))
            val coordinator = AudioUploadCoordinator(ImpoClient(server.url("/").toString(), StaticTokenProvider("a", "alice"), true), store)
            try { coordinator.upload(sealed); fail("Expected lost confirmation") } catch (_: ApiException) {}
            assertFalse(persisted); assertFalse(removed)
            server.enqueue(MockResponse().setBody("""{"status":"uploaded"}"""))
            server.enqueue(MockResponse().setResponseCode(202).setBody(ProtocolJson.encodeToString(receipt)))
            coordinator.upload(sealed)
            val prepare1 = server.takeRequest(); val complete1 = server.takeRequest(); val prepare2 = server.takeRequest(); val complete2 = server.takeRequest()
            assertEquals(prepare1.body.readUtf8(), prepare2.body.readUtf8()); assertEquals(complete1.path, complete2.path)
            assertTrue(removed); assertEquals(4, server.requestCount)
        } finally { server.shutdown() }
    }
    @Test fun durableOutboxSurvivesRestartAndSeparatesAccountAndTask() = runBlocking {
        val directory = temporary.newFolder(); val store = FileConversationOutboxStore(directory)
        val command = MessageCommand.create("same exact context")
        val pending = PendingMessage("alice", command, deviceId = "device")
        val entry = OutboxEntry(pending, MessageReceipt("user", "run")); store.save(entry)
        val reopened = FileConversationOutboxStore(directory)
        assertEquals(entry, reopened.load("alice", null)); assertNull(reopened.load("bob", null)); assertNull(reopened.load("alice", "task"))
        assertFalse(directory.listFiles()!!.single().readText().contains("Bearer"))
        reopened.remove("alice", null); assertNull(store.load("alice", null))
    }
    @Test fun fullHistorySnapshotUpdatesEarlierRunningMessageAndStableIdsDeduplicatePages() {
        val recovery = ConversationRecovery()
        fun message(id: String, sequence: Int, text: String) = ConversationMessage(id, "assistant", sequence, text, "completed", "now")
        recovery.replace(ConversationPage("main", listOf(message("a", 1, "partial"))))
        recovery.merge(ConversationPage("main", listOf(message("b", 2, "second"), message("a", 1, "final"))))
        assertEquals(listOf("final", "second"), recovery.messages.map { it.text })
        recovery.replace(ConversationPage("main", listOf(message("a", 1, "latest"))))
        assertEquals(listOf("latest"), recovery.messages.map { it.text })
        try { recovery.merge(ConversationPage("other", emptyList())); fail("Expected conversation isolation") } catch (_: ProtocolException) {}
    }
    @Test fun boundedRetryDoesNotRetryConflictsCancellationOrNonIdempotentOperations() = runBlocking {
        var calls = 0
        val value = retryIdempotent(initialDelayMillis = 0) { calls++; if (calls < 3) throw IOException("temporary"); "ok" }
        assertEquals("ok", value); assertEquals(3, calls)
        calls = 0
        try { retryIdempotent(initialDelayMillis = 0) { calls++; throw ApiException(409, "idempotency_conflict", "Conflict", true) } } catch (_: ApiException) {}
        assertEquals(1, calls)
        try { retryIdempotent(initialDelayMillis = 0) { calls++; throw CancellationException() } } catch (_: CancellationException) {}
        assertEquals(2, calls)
    }
    @Test fun deviceResultIsPersistedBeforeSubmissionAndReusedAfterLostResult() = runBlocking {
        val server = MockWebServer(); server.start()
        try {
            val input = JsonObject(emptyMap()); val invocation = DeviceInvocation("invocation", "tool", "device", "2030-01-01T00:00:00Z", "calendar_list_events", input)
            var saved: DeviceExecutionReceipt? = null; val executions = AtomicInteger()
            val events = mutableListOf<String>()
            val store = object : DeviceReceiptStore {
                override suspend fun load(accountId: String, invocationId: String) = saved
                override suspend fun save(receipt: DeviceExecutionReceipt) { events += "persist"; saved = receipt }
            }
            repeat(2) { index ->
                server.enqueue(MockResponse().setBody("{\"invocations\":[${ProtocolJson.encodeToString(invocation)}]}"))
                server.enqueue(MockResponse().setBody("""{"executionId":"execution","expiresAt":"2030-01-01T00:00:00Z"}"""))
                server.enqueue(if (index == 0) MockResponse().setResponseCode(503) else MockResponse().setBody("""{"accepted":true,"duplicate":true}"""))
            }
            val runner = DeviceToolRunner(ImpoClient(server.url("/").toString(), StaticTokenProvider("a", "alice"), true), "alice", "device", store,
                DeviceToolExecutor { executions.incrementAndGet(); events += "execute"; JsonPrimitive("output") }, { true }, { Instant.parse("2026-09-30T00:00:00Z") })
            try { runner.runPending(); fail("Expected result retry") } catch (_: ApiException) {}
            assertNotNull(saved)
            assertTrue(runner.runPending().single().duplicate)
            assertEquals(1, executions.get()); assertEquals(listOf("execute", "persist"), events)
            val requests = (1..6).map { server.takeRequest() }
            assertEquals(requests[2].body.readUtf8(), requests[5].body.readUtf8())
            assertTrue(requests[1].path!!.endsWith("/claim"))
        } finally { server.shutdown() }
    }
    @Test fun revokedCapabilityReturnsFailureWithoutNativeAccess() = runBlocking {
        val server = MockWebServer(); server.start()
        try {
            server.enqueue(MockResponse().setBody("""{"invocations":[{"invocationId":"i","toolCallId":"t","deviceId":"d","expiresAt":"2030-01-01T00:00:00Z","toolName":"calendar_list_events","input":{}}]}"""))
            server.enqueue(MockResponse().setBody("""{"executionId":"e","expiresAt":"2030-01-01T00:00:00Z"}"""))
            server.enqueue(MockResponse().setBody("""{"accepted":true,"duplicate":false}"""))
            var savedReceipt: DeviceExecutionReceipt? = null
            val store = object : DeviceReceiptStore {
                override suspend fun load(accountId: String, invocationId: String): DeviceExecutionReceipt? = null
                override suspend fun save(receipt: DeviceExecutionReceipt) { savedReceipt = receipt }
            }
            DeviceToolRunner(ImpoClient(server.url("/").toString(), StaticTokenProvider("a", "alice"), true), "alice", "d", store,
                DeviceToolExecutor { fail("Permission revoked"); JsonPrimitive(false) }, { false }).runPending()
            val persisted = checkNotNull(savedReceipt)
            assertEquals("permission_revoked", persisted.result.error); assertFalse(persisted.result.success)
        } finally { server.shutdown() }
    }
}
