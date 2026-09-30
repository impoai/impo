package ai.impo.client

import kotlinx.coroutines.flow.last
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.time.Instant
import java.util.UUID

/** Opt-in against scripts/android-ui-fixture.ts, which uses the production HTTP/SSE adapter.
 * IMPO_ANDROID_FIXTURE_URL=http://127.0.0.1:3011 npm run test:android:client
 * Synthetic local identities only; no production credentials or external provider calls.
 * Gradle must treat the fixture URL as a test input so toggling it re-executes this test.
 */
class LocalFixtureTest {
    @Test fun productionRoutesProveIdempotencyRecoveryOwnershipAndExactUploadAcceptance() = runBlocking {
        val endpoint = System.getenv("IMPO_ANDROID_FIXTURE_URL")
        assumeTrue("Set IMPO_ANDROID_FIXTURE_URL to run the local production-router fixture", endpoint != null)
        require(endpoint!!.startsWith("http://127.0.0.1:") || endpoint.startsWith("http://localhost:"))
        val alice = ImpoClient(endpoint, StaticTokenProvider("instant-dev-alice", "alice"), true)
        val bob = ImpoClient(endpoint, StaticTokenProvider("instant-dev-bob", "bob"), true)
        assertNotEquals(alice.conversation().conversationId, bob.conversation().conversationId)
        val command = MessageCommand.create("Android Kotlin protocol integration ${UUID.randomUUID()}")
        val receipt = alice.sendMessage(command)
        assertEquals(receipt, alice.sendMessage(command))
        expectStatus(409) { alice.sendMessage(command.copy(text = "Changed content")) }
        expectStatus(404) { bob.submission(receipt.submissionId) }
        expectStatus(404) { bob.streamSubmission(receipt.submissionId).last() }
        val first = alice.streamSubmission(receipt.submissionId).last()
        val replay = alice.streamSubmission(receipt.submissionId).last()
        assertTrue(first.done); assertTrue(first.finished); assertTrue(first.text.contains("👋"))
        assertEquals(first.text, replay.text); assertEquals(first.messageId, replay.messageId)
        assertNotEquals(receipt.messageId, first.messageId)
        val taskCommand = MessageCommand.create("Independent Kotlin protocol task ${UUID.randomUUID()}")
        val task = alice.createTask(taskCommand)
        assertEquals(task, alice.createTask(taskCommand))
        expectStatus(404) { bob.taskConversation(task.taskId) }
        expectStatus(409) { alice.sendTaskMessage(task.taskId, command) }
        assertNotEquals(alice.conversation().conversationId, alice.taskConversation(task.taskId).conversationId)
        val device = alice.registerDevice(UUID.randomUUID().toString())
        expectStatus(404) { bob.pendingDeviceInvocations(device.deviceId) }
        val brief = alice.briefs().briefs.firstOrNull()
        if (brief != null) expectStatus(404) { bob.brief(brief.id) }
        val record = alice.echoHistory().segments.firstOrNull()
        if (record != null) expectStatus(404) { bob.updateEchoLabel(record.id, "Forbidden") }
        val memory = alice.memories().memories.firstOrNull()
        if (memory != null) expectStatus(404) { bob.deleteMemory(memory.id) }
        val now = Instant.now()
        val sealed = SealedAudioUpload.create("alice", SealedBatch(UUID.randomUUID().toString(), UUID.randomUUID().toString(), 1, UUID.randomUUID().toString(), listOf(
            AudioItem(UUID.randomUUID().toString(), now.minusSeconds(1).toString(), now.toString(), "audio/mp4", "AQID"))))
        val ticket = alice.prepareAudioUpload(sealed.manifest)
        assertEquals("upload", ticket.status)
        alice.uploadAudio(ticket, sealed.bytes)
        expectStatus(404) { bob.completeAudioUpload(sealed.manifest.batch.batchId) }
        val accepted = alice.completeAudioUpload(sealed.manifest.batch.batchId)
        sealed.validateMatchingReceipt(accepted)
        assertEquals(accepted, alice.completeAudioUpload(sealed.manifest.batch.batchId))
        expectStatus(404) { bob.batchStatus(sealed.manifest.batch.batchId) }
        assertEquals("accepted", alice.prepareAudioUpload(sealed.manifest).status)
        assertEquals("transcribed", alice.batchStatus(sealed.manifest.batch.batchId).status)
        alice.cancelSubmission(task.submissionId)
        Unit
    }
    private suspend fun expectStatus(status: Int, work: suspend () -> Any?) {
        try { work(); fail("Expected HTTP $status") } catch (error: ApiException) { assertEquals(status, error.statusCode) }
    }
}
