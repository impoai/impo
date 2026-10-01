package ai.impo.nativebridge

import ai.impo.client.EchoSchedule
import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class EchoStopDeadlineTest {
    private val plan = EchoSchedule(enabled = true)
    @Test fun resumeNeverMovesAnExpiredStopToTomorrow() {
        val deadline = EchoStopDeadline()
        deadline.start(plan, Instant.parse("2026-10-01T09:03:00Z"))
        assertEquals(Instant.parse("2026-10-01T18:00:00Z"), deadline.stopAt)
        deadline.start(plan, Instant.parse("2026-10-01T19:00:00Z"))
        assertTrue(deadline.expired(Instant.parse("2026-10-01T18:00:00Z")))
        assertFalse(deadline.expired(Instant.parse("2026-10-01T17:59:59Z")))
        deadline.clear()
        deadline.start(plan, Instant.parse("2026-10-01T19:00:00Z"))
        assertEquals(Instant.parse("2026-10-02T18:00:00Z"), deadline.stopAt)
    }
    @Test fun accountScheduleEditsKeepTheSessionAnchorAndCanRemoveDeadline() {
        val deadline = EchoStopDeadline()
        deadline.start(plan, Instant.parse("2026-10-01T09:00:00Z"))
        deadline.update(plan.copy(stopTime = "10:00"))
        assertTrue(deadline.expired(Instant.parse("2026-10-01T11:00:00Z")))
        deadline.update(plan.copy(autoStop = false))
        assertNull(deadline.stopAt)
        deadline.update(plan.copy(enabled = false))
        assertNull(deadline.stopAt)
    }
}
