package ai.impo.nativebridge

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.*
import org.junit.Test

class NativeLifecycleTest {
    @Test fun recoveryFinishingAfterCaptureStartsPreservesLiveRecording() {
        val state = MutableStateFlow(EchoRecordingState())
        val recovery = EchoRecoveryState(state)
        val ticket = requireNotNull(recovery.begin("account-a"))
        val recording = EchoRecordingState(status = "recording", level = .6f, speech = true)
        state.value = recording

        assertTrue(recovery.complete(ticket, "account-a", 3, "An older batch needs recovery."))
        assertEquals(recording.copy(pendingBatches = 3, message = "An older batch needs recovery."), state.value)
        assertNull(recovery.begin("account-a"))
        assertTrue(state.value.isRecording)
    }

    @Test fun recoveryDoesNotReplaceAnInterruptionMessageOrPausedState() {
        val state = MutableStateFlow(EchoRecordingState())
        val recovery = EchoRecoveryState(state)
        val ticket = requireNotNull(recovery.begin("account-a"))
        state.value = EchoRecordingState(status = "paused", message = "Microphone was interrupted.")

        recovery.complete(ticket, "account-a", 2, "An older batch needs recovery.")
        assertEquals(EchoRecordingState(status = "paused", message = "Microphone was interrupted.", pendingBatches = 2), state.value)
    }

    @Test fun recoveryFromAnEarlierLoginCannotPublishIntoTheSameAccountsNewSession() {
        val state = MutableStateFlow(EchoRecordingState())
        val recovery = EchoRecoveryState(state)
        val old = requireNotNull(recovery.begin("account-a"))
        state.value = EchoRecordingState(status = "recording")
        recovery.begin(null)
        assertEquals(EchoRecordingState(), state.value)
        val current = requireNotNull(recovery.begin("account-a"))
        state.value = EchoRecordingState(status = "paused", pendingBatches = 1)

        assertFalse(recovery.complete(old, "account-a", 8, "Old session error"))
        assertEquals(EchoRecordingState(status = "paused", pendingBatches = 1), state.value)
        assertFalse(recovery.complete(current, "account-b", 5, null))
        assertTrue(recovery.complete(current, "account-a", 2, null))
        assertEquals(EchoRecordingState(status = "paused", pendingBatches = 2), state.value)
    }

    @Test fun disablingLocationBeforeDelayedStartupNeverRegistersUpdates() {
        var registrations = 0
        var removals = 0
        val subscription = LocationSubscription(register = { registrations += 1; true }, unregister = { removals += 1 })
        subscription.stop()
        subscription.start()
        subscription.start()
        subscription.stop()

        assertEquals(0, registrations)
        assertEquals(1, removals)
        assertFalse(subscription.active)
    }

    @Test fun disablingLocationDuringRegistrationRemovesTheCompletedSubscription() {
        val entered = CountDownLatch(1)
        val finishRegistration = CountDownLatch(1)
        val stopRequested = CountDownLatch(1)
        val platformActive = AtomicBoolean(false)
        val registrations = AtomicInteger()
        val removals = AtomicInteger()
        val subscription = LocationSubscription(register = {
            registrations.incrementAndGet()
            entered.countDown()
            check(finishRegistration.await(5, TimeUnit.SECONDS))
            platformActive.set(true)
            true
        }, unregister = { platformActive.set(false); removals.incrementAndGet(); Unit })
        val executor = Executors.newFixedThreadPool(2)
        try {
            val start = executor.submit { subscription.start() }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            val stop = executor.submit { stopRequested.countDown(); subscription.stop() }
            assertTrue(stopRequested.await(5, TimeUnit.SECONDS))
            finishRegistration.countDown()
            start.get(5, TimeUnit.SECONDS)
            stop.get(5, TimeUnit.SECONDS)
            subscription.start()

            assertFalse(platformActive.get())
            assertFalse(subscription.active)
            assertEquals(1, registrations.get())
            assertEquals(1, removals.get())
        } finally {
            finishRegistration.countDown()
            executor.shutdownNow()
        }
    }
}
