package ai.impo.nativebridge

import ai.impo.client.EchoSchedule
import java.time.Instant

/** A resume or recorder replacement must never advance the original session's deadline. */
internal class EchoStopDeadline {
    private var anchor: Instant? = null
    @Volatile var stopAt: Instant? = null
        private set
    fun start(schedule: EchoSchedule, now: Instant) {
        if (anchor == null) anchor = now
        update(schedule)
    }
    fun update(schedule: EchoSchedule) { stopAt = anchor?.let(schedule::nextStop) }
    fun expired(now: Instant = Instant.now()): Boolean = stopAt?.let { now >= it } == true
    fun clear() { anchor = null; stopAt = null }
}
