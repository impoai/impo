package ai.impo.nativebridge

import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.*
import org.junit.Test

class EchoSessionAuthorizationTest {
    @Test fun delayedStartCannotAcquireTheMicrophoneAfterSwitchingAccounts() {
        val initiating = EchoCaptureSession("alice")
        val queuedStart = initiating.token
        val current = EchoCaptureSession("bob")
        assertTrue(initiating.accepts(queuedStart, initiating))
        assertFalse(current.accepts(queuedStart, current))
        assertFalse(initiating.accepts(queuedStart, current))
        assertFalse(initiating.accepts(queuedStart, null))
    }

    @Test fun sameUserReauthenticationInvalidatesCaptureAndNotificationControls() {
        val earlier = EchoCaptureSession("alice")
        val restored = EchoCaptureSession("alice")
        assertEquals(earlier.accountId, restored.accountId) // Durable audio ownership remains unchanged.
        assertNotEquals(earlier.token, restored.token)
        assertFalse(earlier.isCurrent(restored))
        assertFalse(restored.accepts(earlier.token, restored))
        assertTrue(restored.accepts(restored.token, restored))
    }

    @Test fun missingOrForgedIntentAuthorizationNeverStartsCapture() {
        val session = EchoCaptureSession("alice")
        assertFalse(session.accepts(null, session))
        assertFalse(session.accepts("", session))
        assertFalse(session.accepts("alice", session))
        assertTrue(session.isCurrent(session))
        assertFalse(session.isCurrent(null))
    }

    @Test fun sameAccountSessionReplacementResetsStateAndRejectsEarlierRecovery() {
        val state = MutableStateFlow(EchoRecordingState())
        val recovery = EchoRecoveryState(state)
        val earlier = EchoCaptureSession("alice")
        val oldWork = requireNotNull(recovery.begin(earlier.accountId, earlier.token))
        state.value = EchoRecordingState(status = "recording")
        val replacement = EchoCaptureSession("alice")
        val newWork = requireNotNull(recovery.begin(replacement.accountId, replacement.token))
        assertEquals(EchoRecordingState(), state.value)
        assertFalse(recovery.complete(oldWork, "alice", 8, "Old session", replacement.token))
        assertTrue(recovery.complete(newWork, "alice", 2, null, replacement.token))
        assertEquals(2, state.value.pendingBatches)
    }
}
