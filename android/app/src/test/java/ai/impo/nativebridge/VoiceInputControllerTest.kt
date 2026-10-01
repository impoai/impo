package ai.impo.nativebridge

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VoiceInputControllerTest {
    private class Engine(val listener: (VoiceCaptureEvent) -> Unit) : VoiceRecorder {
        var starts = 0; var finishes = 0; var closes = 0
        var recording: VoiceRecording? = VoiceRecording(RecordedVoiceClip.fromBytes(byteArrayOf(1, 2, 3)), 1_000)
        var duringFinish: () -> Unit = {}
        override fun start() { starts++; listener(VoiceCaptureEvent.Ready) }
        override fun finish(): VoiceRecording? { finishes++; duringFinish(); return recording }
        override fun close() { closes++ }
        fun level(value: Float = 0.7f) = listener(VoiceCaptureEvent.Level(value))
        fun limit() = listener(VoiceCaptureEvent.LimitReached)
    }
    private class Factory : VoiceRecorderFactory {
        val engines = mutableListOf<Engine>()
        override fun create(listener: (VoiceCaptureEvent) -> Unit) = Engine(listener).also(engines::add)
        val latest get() = engines.last()
    }

    @Test fun releaseTransfersOneImmutableClipOnlyAfterCleanup() = runTest {
        val factory = Factory(); val sent = mutableListOf<RecordedVoiceClip>()
        val controller = VoiceInputController(this, factory, onClip = {
            assertFalse(VoiceMicrophone.inUse.value)
            assertEquals(1, factory.latest.closes)
            sent.add(it)
        })
        try {
            controller.begin(); runCurrent(); factory.latest.level(); runCurrent()
            assertTrue(sent.isEmpty()); assertTrue(VoiceMicrophone.inUse.value)
            controller.finish(); controller.finish()
            factory.latest.limit(); factory.latest.level(); runCurrent(); advanceTimeBy(150_000); runCurrent()
            assertEquals(1, sent.size); assertEquals(1, factory.latest.finishes)
            assertEquals(VoicePhase.Idle, controller.state.value.phase)
            assertArrayEquals(byteArrayOf(1, 2, 3), sent.single().bytes())
            // Closing the screen after transfer cannot revoke an already accepted server command.
            controller.close(); assertEquals(1, sent.size)
        } finally { controller.close() }
    }

    @Test fun encoderLimitClosesMicrophoneButNeverSendsBeforeRelease() = runTest {
        val factory = Factory(); val sent = mutableListOf<RecordedVoiceClip>()
        val controller = VoiceInputController(this, factory, onClip = sent::add)
        try {
            controller.begin(); runCurrent(); factory.latest.level(); factory.latest.limit(); runCurrent()
            assertTrue(sent.isEmpty()); assertTrue(controller.state.value.active)
            assertTrue(controller.state.value.limitReached); assertFalse(VoiceMicrophone.inUse.value)
            assertEquals(1, factory.latest.finishes); assertEquals(1, factory.latest.closes)
            factory.latest.limit(); runCurrent(); controller.finish()
            assertEquals(1, sent.size); assertEquals(1, factory.latest.finishes)
        } finally { controller.close() }
    }

    @Test fun slidingUpCancelsEvenAClipAlreadyFinalizedAtTheLimit() = runTest {
        val factory = Factory(); val sent = mutableListOf<RecordedVoiceClip>()
        val controller = VoiceInputController(this, factory, onClip = sent::add)
        try {
            controller.begin(); runCurrent(); factory.latest.level(); factory.latest.limit(); runCurrent()
            controller.move(true); controller.finish(); runCurrent()
            assertTrue(sent.isEmpty()); assertEquals(VoiceInputState(), controller.state.value)
            assertFalse(VoiceMicrophone.inUse.value)
        } finally { controller.close() }
    }

    @Test fun movingBackDownBeforeReleaseRestoresSubmission() = runTest {
        val factory = Factory(); val sent = mutableListOf<RecordedVoiceClip>()
        val controller = VoiceInputController(this, factory, onClip = sent::add)
        try {
            controller.begin(); runCurrent(); factory.latest.level(); runCurrent()
            controller.move(true); controller.move(false); controller.finish()
            assertEquals(1, sent.size)
        } finally { controller.close() }
    }

    @Test fun cancellationFeedbackOnlyFollowsCrossingTheBoundaryDuringAHold() = runTest {
        val factory = Factory(); val boundaries = mutableListOf<Boolean>()
        val controller = VoiceInputController(this, factory, onClip = {}, onCancelBoundaryChanged = boundaries::add)
        try {
            controller.move(true)
            val ticket = controller.permissionRequested()
            controller.move(true); controller.permissionResult(ticket, true)
            assertTrue(boundaries.isEmpty())
            controller.begin(); runCurrent()
            controller.move(false); controller.move(true); controller.move(true)
            controller.move(false); controller.move(false); controller.move(true)
            assertEquals(listOf(true, false, true), boundaries)
            controller.finish(); controller.move(false); controller.cancel(); controller.close()
            assertEquals(listOf(true, false, true), boundaries)
        } finally { controller.close() }
    }

    @Test fun cancellationDestroysCaptureAndRejectsAllLateEvents() = runTest {
        val factory = Factory(); val sent = mutableListOf<RecordedVoiceClip>()
        val controller = VoiceInputController(this, factory, onClip = sent::add)
        try {
            controller.begin(); runCurrent(); controller.cancel()
            factory.latest.level(); factory.latest.limit()
            factory.latest.listener(VoiceCaptureEvent.Failure("Stale error")); runCurrent()
            advanceTimeBy(150_000); runCurrent(); controller.finish()
            assertTrue(sent.isEmpty()); assertEquals(VoiceInputState(), controller.state.value)
            assertEquals(0, factory.latest.finishes); assertEquals(1, factory.latest.closes)
            assertFalse(VoiceMicrophone.inUse.value)
        } finally { controller.close() }
    }

    @Test fun anOldHoldCannotStopTheNextHoldOrChangeItsLevels() = runTest {
        val factory = Factory(); val sent = mutableListOf<RecordedVoiceClip>()
        val controller = VoiceInputController(this, factory, onClip = sent::add)
        try {
            controller.begin(); runCurrent(); val old = factory.latest; controller.cancel()
            controller.begin(); runCurrent(); factory.latest.level(.6f)
            old.level(1f); old.limit(); old.listener(VoiceCaptureEvent.Failure("Old account")); runCurrent()
            assertFalse(controller.state.value.limitReached)
            assertEquals(.6f, controller.state.value.levels.last(), .001f)
            assertEquals(0, factory.latest.finishes)
            controller.finish(); assertEquals(1, sent.size)
        } finally { controller.close() }
    }

    @Test fun permissionCompletionRequiresFreshPressAndOldResultCannotAffectCapture() = runTest {
        val factory = Factory(); val controller = VoiceInputController(this, factory, onClip = {})
        try {
            val ticket = controller.permissionRequested()
            controller.cancel() // The system dialog cancels the original pointer hold.
            controller.permissionResult(ticket, true); runCurrent()
            assertTrue(factory.engines.isEmpty()); assertTrue(controller.state.value.message!!.contains("Hold"))
            controller.begin(); runCurrent(); controller.permissionResult(ticket, false)
            assertEquals(VoicePhase.Recording, controller.state.value.phase)
            assertNull(controller.state.value.message)
        } finally { controller.close() }
    }

    @Test fun silentShortEmptyAndOverlongCapturesNeverLeaveTheController() = runTest {
        val factory = Factory(); val sent = mutableListOf<RecordedVoiceClip>()
        val controller = VoiceInputController(this, factory, onClip = sent::add)
        try {
            // Silence, sub-400ms, failed encoder, and a malicious/buggy duration are all discarded.
            listOf(1_000L to 0.14f, 399L to 1f, 0L to 1f, 120_001L to 1f).forEach { (duration, amplitude) ->
                controller.begin(); runCurrent(); factory.latest.level(amplitude); runCurrent()
                factory.latest.recording = if (duration == 0L) null else factory.latest.recording!!.copy(durationMillis = duration)
                controller.finish()
                assertTrue(sent.isEmpty()); assertTrue(controller.state.value.message!!.contains("Didn't catch"))
                assertFalse(VoiceMicrophone.inUse.value)
            }
            controller.begin(); runCurrent(); factory.latest.level(.15f); runCurrent()
            factory.latest.recording = factory.latest.recording!!.copy(durationMillis = 400)
            controller.finish(); assertEquals(1, sent.size)
        } finally { controller.close() }
    }

    @Test fun echoOrAccountChangeBlocksStartAndAChangeDuringFinishRejectsTheClip() = runTest {
        val factory = Factory(); val sent = mutableListOf<RecordedVoiceClip>(); var blocked: String? = "Pause Echo"
        val controller = VoiceInputController(this, factory, { blocked }, sent::add)
        try {
            controller.begin(); assertTrue(factory.engines.isEmpty())
            blocked = null; controller.begin(); runCurrent(); factory.latest.level(); runCurrent()
            factory.latest.duringFinish = { blocked = "Account changed" }
            controller.finish()
            assertTrue(sent.isEmpty()); assertEquals("Account changed", controller.state.value.message)
            assertFalse(VoiceMicrophone.inUse.value)
        } finally { controller.close() }
    }

    @Test fun disposalReleasesMicrophoneAndCannotReviveOrSend() = runTest {
        val factory = Factory(); val sent = mutableListOf<RecordedVoiceClip>()
        val controller = VoiceInputController(this, factory, onClip = sent::add)
        controller.begin(); runCurrent(); controller.close()
        factory.latest.level(); factory.latest.limit(); runCurrent(); controller.begin(); controller.finish(); runCurrent()
        assertEquals(1, factory.engines.size); assertEquals(1, factory.latest.closes)
        assertTrue(sent.isEmpty()); assertFalse(VoiceMicrophone.inUse.value)
    }

    @Test fun failedStartReleasesTheMicrophoneAndReportsAnActionableError() = runTest {
        val controller = VoiceInputController(this, VoiceRecorderFactory { error("native capture unavailable") }, onClip = { fail() })
        controller.begin()
        assertTrue(controller.state.value.message!!.contains("Microphone access"))
        assertFalse(VoiceMicrophone.inUse.value); controller.close()
    }

    @Test fun twoMinuteTimerFinalizesWithoutSendingAndTheHeldClipCanStillBeCancelled() = runTest {
        val factory = Factory(); val sent = mutableListOf<RecordedVoiceClip>()
        val controller = VoiceInputController(this, factory, onClip = sent::add)
        try {
            controller.begin(); runCurrent(); factory.latest.level(); runCurrent()
            advanceTimeBy(120_000); runCurrent()
            assertTrue(controller.state.value.active); assertTrue(controller.state.value.limitReached)
            assertFalse(VoiceMicrophone.inUse.value); assertTrue(sent.isEmpty())
            assertEquals(1, factory.latest.finishes)
            controller.cancel(); controller.finish(); assertTrue(sent.isEmpty())
        } finally { controller.close() }
    }

    @Test fun failedFinalizationAndReentrantCancellationCannotSubmit() = runTest {
        val factory = Factory(); val sent = mutableListOf<RecordedVoiceClip>()
        val controller = VoiceInputController(this, factory, onClip = sent::add)
        try {
            controller.begin(); runCurrent(); factory.latest.level(); runCurrent()
            factory.latest.duringFinish = { error("file disappeared") }; controller.finish()
            assertTrue(sent.isEmpty()); assertFalse(VoiceMicrophone.inUse.value)
            assertTrue(controller.state.value.message!!.contains("Couldn't finish"))
            controller.begin(); runCurrent(); factory.latest.level(); runCurrent()
            factory.latest.duringFinish = { controller.cancel() }; controller.finish()
            assertTrue(sent.isEmpty()); assertFalse(VoiceMicrophone.inUse.value)
        } finally { controller.close() }
    }

    @Test fun repeatedBeginCannotCreateCompetingCaptureAndLevelsStayBounded() = runTest {
        val factory = Factory(); val controller = VoiceInputController(this, factory, onClip = {})
        try {
            controller.begin(); controller.begin(); runCurrent()
            repeat(100) { factory.latest.level(if (it % 2 == 0) -5f else 8f) }
            factory.latest.level(Float.NaN); runCurrent()
            assertEquals(1, factory.engines.size); assertEquals(40, controller.state.value.levels.size)
            assertTrue(controller.state.value.levels.all { it in 0f..1f })
        } finally { controller.close() }
    }
}
