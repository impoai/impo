package ai.impo.data

import com.clerk.api.session.Session
import org.junit.Assert.*
import org.junit.Test

class SessionTokenFailureTest {
    @Test fun activeOrUnknownTokenFailureIsRetryableNotExpired() {
        listOf(Session.SessionStatus.ACTIVE, Session.SessionStatus.UNKNOWN).forEach { status ->
            val failure = sessionTokenFailure(status)
            assertEquals(503, failure.statusCode)
            assertEquals("session_token_unavailable", failure.code)
            assertTrue(failure.retryable)
            assertFalse(failure.message.contains("expired"))
            assertFalse(failure.message.contains("sign in again"))
        }
    }

    @Test fun endedSessionsRequireSignIn() {
        listOf(
            Session.SessionStatus.ABANDONED,
            Session.SessionStatus.ENDED,
            Session.SessionStatus.EXPIRED,
            Session.SessionStatus.REMOVED,
            Session.SessionStatus.REPLACED,
            Session.SessionStatus.REVOKED,
        ).forEach { status ->
            val failure = sessionTokenFailure(status)
            assertEquals(401, failure.statusCode)
            assertEquals("unauthorized", failure.code)
            assertFalse(failure.retryable)
            assertTrue(failure.message.contains("sign in again"))
        }
    }

    @Test fun pendingSessionRequiresCompletionNotExpiryRecovery() {
        val failure = sessionTokenFailure(Session.SessionStatus.PENDING)
        assertEquals(401, failure.statusCode)
        assertEquals("Complete sign-in to continue.", failure.message)
        assertFalse(failure.retryable)
    }
}
