package ai.impo.nativebridge

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VoiceInputControllerTest {
    private class Engine(val listener: (VoiceRecognitionEvent) -> Unit) : VoiceRecognizer {
        override val onDevice = true
        var starts = 0; var finishes = 0; var closes = 0
        override fun start() { starts++; listener(VoiceRecognitionEvent.Ready) }
        override fun finish() { finishes++ }
        override fun close() { closes++ }
        fun partial(text: String) = listener(VoiceRecognitionEvent.Partial(text))
        fun final(text: String) = listener(VoiceRecognitionEvent.Final(text))
    }
    private class Factory : VoiceRecognizerFactory {
        val engines = mutableListOf<Engine>()
        override fun create(listener: (VoiceRecognitionEvent) -> Unit) = Engine(listener).also(engines::add)
        val latest get() = engines.last()
    }

    @Test fun releaseWaitsForFinalAndSendsExactlyOnce() = runTest {
        val factory = Factory(); val sent = mutableListOf<String>()
        val controller = VoiceInputController(this, factory, onTranscript = sent::add)
        try {
            controller.begin(); runCurrent()
            factory.latest.partial("hello"); runCurrent()
            controller.finish(); controller.finish()
            assertEquals(VoicePhase.Finishing, controller.state.value.phase)
            assertTrue(sent.isEmpty()); assertEquals(1, factory.latest.finishes)
            factory.latest.final("  hello world  "); runCurrent()
            factory.latest.final("duplicate"); runCurrent(); advanceTimeBy(5_000); runCurrent()
            assertEquals(listOf("hello world"), sent)
            assertEquals(1, factory.latest.closes)
            assertFalse(VoiceMicrophone.inUse.value)
        } finally { controller.close() }
    }

    @Test fun recognizerEndpointDoesNotSendUntilUserReleases() = runTest {
        val factory = Factory(); val sent = mutableListOf<String>()
        val controller = VoiceInputController(this, factory, onTranscript = sent::add)
        try {
            controller.begin(); runCurrent()
            factory.latest.final("early result"); runCurrent()
            assertTrue(sent.isEmpty()); assertTrue(controller.state.value.active)
            controller.finish()
            assertEquals(listOf("early result"), sent)
        } finally { controller.close() }
    }

    @Test fun slidingUpThenReleaseCancelsEvenACompletedTranscript() = runTest {
        val factory = Factory(); val sent = mutableListOf<String>()
        val controller = VoiceInputController(this, factory, onTranscript = sent::add)
        try {
            controller.begin(); runCurrent(); factory.latest.final("do not send"); runCurrent()
            controller.move(true); controller.finish(); runCurrent()
            assertTrue(sent.isEmpty()); assertEquals(VoicePhase.Idle, controller.state.value.phase)
            assertEquals("", controller.state.value.transcript)
        } finally { controller.close() }
    }

    @Test fun movingBackDownBeforeReleaseRestoresSend() = runTest {
        val factory = Factory(); val sent = mutableListOf<String>()
        val controller = VoiceInputController(this, factory, onTranscript = sent::add)
        try {
            controller.begin(); runCurrent(); controller.move(true); controller.move(false); controller.finish()
            factory.latest.final("keep it"); runCurrent()
            assertEquals(listOf("keep it"), sent)
        } finally { controller.close() }
    }

    @Test fun cancellationDuringFinalizationRejectsAllLateCallbacks() = runTest {
        val factory = Factory(); val sent = mutableListOf<String>()
        val controller = VoiceInputController(this, factory, onTranscript = sent::add)
        try {
            controller.begin(); runCurrent(); controller.finish(); controller.cancel()
            factory.latest.partial("late partial"); factory.latest.final("late final"); runCurrent()
            advanceTimeBy(5_000); runCurrent()
            assertTrue(sent.isEmpty()); assertEquals(VoiceInputState(), controller.state.value)
            assertFalse(VoiceMicrophone.inUse.value)
        } finally { controller.close() }
    }

    @Test fun anOldHoldCannotOverwriteOrSendTheNextHoldsTranscript() = runTest {
        val factory = Factory(); val sent = mutableListOf<String>()
        val controller = VoiceInputController(this, factory, onTranscript = sent::add)
        try {
            controller.begin(); runCurrent(); val old = factory.latest; controller.cancel()
            controller.begin(); runCurrent(); factory.latest.partial("new"); old.final("old"); runCurrent()
            assertEquals("new", controller.state.value.transcript)
            controller.finish(); factory.latest.final("new final"); runCurrent()
            assertEquals(listOf("new final"), sent)
        } finally { controller.close() }
    }

    @Test fun permissionCompletionRequiresFreshPressAndOldResultCannotAffectCapture() = runTest {
        val factory = Factory()
        val controller = VoiceInputController(this, factory, onTranscript = {})
        try {
            val ticket = controller.permissionRequested()
            controller.cancel() // The system permission dialog cancels the original pointer hold.
            controller.permissionResult(ticket, true); runCurrent()
            assertTrue(factory.engines.isEmpty()); assertTrue(controller.state.value.message!!.contains("Hold"))
            controller.begin(); runCurrent(); controller.permissionResult(ticket, false)
            assertEquals(VoicePhase.Listening, controller.state.value.phase)
            assertNull(controller.state.value.message)
        } finally { controller.close() }
    }

    @Test fun timeoutUsesTheLastPartialOnceAndEmptySpeechNeverSends() = runTest {
        val factory = Factory(); val sent = mutableListOf<String>()
        val controller = VoiceInputController(this, factory, onTranscript = sent::add)
        try {
            controller.begin(); runCurrent(); factory.latest.partial("你好，Impo"); runCurrent(); controller.finish()
            advanceTimeBy(3_000); runCurrent(); factory.latest.final("too late"); runCurrent()
            assertEquals(listOf("你好，Impo"), sent)
            controller.begin(); runCurrent(); controller.finish(); factory.latest.final(" \n "); runCurrent()
            assertEquals(1, sent.size); assertTrue(controller.state.value.message!!.contains("No speech"))
        } finally { controller.close() }
    }

    @Test fun echoOrAccountChangeBlocksStartAndCancelsFinishing() = runTest {
        val factory = Factory(); val sent = mutableListOf<String>(); var blocked: String? = "Pause Echo"
        val controller = VoiceInputController(this, factory, { blocked }, sent::add)
        try {
            controller.begin(); assertTrue(factory.engines.isEmpty())
            blocked = null; controller.begin(); runCurrent(); controller.finish()
            blocked = "Account changed"; factory.latest.final("private old account"); runCurrent()
            assertTrue(sent.isEmpty()); assertEquals("Account changed", controller.state.value.message)
            assertFalse(VoiceMicrophone.inUse.value)
        } finally { controller.close() }
    }

    @Test fun disposalReleasesMicrophoneAndCannotReviveOrSend() = runTest {
        val factory = Factory(); val sent = mutableListOf<String>()
        val controller = VoiceInputController(this, factory, onTranscript = sent::add)
        controller.begin(); runCurrent(); controller.finish(); controller.close()
        factory.latest.final("late"); runCurrent(); controller.begin(); runCurrent()
        assertEquals(1, factory.engines.size); assertEquals(1, factory.latest.closes)
        assertTrue(sent.isEmpty()); assertFalse(VoiceMicrophone.inUse.value)
    }

    @Test fun failedStartAndMaxDurationReleaseTheMicrophoneWithoutSending() = runTest {
        val sent = mutableListOf<String>()
        val missing = VoiceInputController(this, VoiceRecognizerFactory { error("No speech service") }, onTranscript = sent::add)
        missing.begin(); assertEquals("No speech service", missing.state.value.message); assertFalse(VoiceMicrophone.inUse.value); missing.close()
        val factory = Factory(); val controller = VoiceInputController(this, factory, onTranscript = sent::add)
        try {
            controller.begin(); runCurrent(); factory.latest.partial("not automatically sent"); runCurrent()
            advanceTimeBy(60_000); runCurrent()
            assertFalse(controller.state.value.active); assertFalse(VoiceMicrophone.inUse.value); assertTrue(sent.isEmpty())
        } finally { controller.close() }
    }

    @Test fun repeatedBeginCannotCreateCompetingRecognizerAndLevelsStayBounded() = runTest {
        val factory = Factory(); val controller = VoiceInputController(this, factory, onTranscript = {})
        try {
            controller.begin(); controller.begin(); runCurrent()
            repeat(100) { factory.latest.listener(VoiceRecognitionEvent.Level(if (it % 2 == 0) -5f else 8f)) }
            factory.latest.listener(VoiceRecognitionEvent.Level(Float.NaN)); runCurrent()
            assertEquals(1, factory.engines.size); assertEquals(40, controller.state.value.levels.size)
            assertTrue(controller.state.value.levels.all { it in 0f..1f })
        } finally { controller.close() }
    }
}
