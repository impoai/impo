import XCTest
import AVFoundation
import Speech
@testable import Instant

@MainActor
final class VoiceDictationTests: XCTestCase {
    func testPhysicalMicrophoneReceivesAudioAndCanRestart() async throws {
        guard ProcessInfo.processInfo.environment["IMPO_VOICE_HARDWARE_QA"] == "1",
              Bundle.main.bundleIdentifier == "ai.impo.voiceqa" else {
            throw XCTSkip("Opt-in real microphone test in the isolated QA app")
        }
        XCTAssertEqual(AVAudioApplication.shared.recordPermission, .granted)
        XCTAssertEqual(SFSpeechRecognizer.authorizationStatus(), .authorized)
        let dictation = VoiceDictation(fixture: nil)
        defer { dictation.cancel() }
        for attempt in 0..<3 {
            dictation.begin()
            try await Task.sleep(for: .seconds(4))
            XCTAssertEqual(dictation.phase, .recording)
            XCTAssertTrue(dictation.levels.contains { $0 > 0 }, "Real microphone samples must reach the UI")
            if attempt == 1 {
                _ = await dictation.finish()
            } else {
                dictation.cancel()
            }
            XCTAssertEqual(dictation.phase, .idle)
        }
    }

    func testAudioAndRecognitionCallbacksCanEnterFromBackgroundQueues() async {
        let audioDelivered = expectation(description: "Audio level reaches MainActor")
        let resultDelivered = expectation(description: "Recognition result reaches MainActor")
        let callbacks = BackgroundCallbacks(
            audio: VoiceDictation.audioTap(request: SFSpeechAudioBufferRecognitionRequest()) { level in
                MainActor.assertIsolated()
                XCTAssertGreaterThan(level, 0)
                audioDelivered.fulfill()
            },
            recognition: VoiceDictation.recognitionHandler { text, done in
                MainActor.assertIsolated()
                XCTAssertNil(text)
                XCTAssertTrue(done)
                resultDelivered.fulfill()
            }
        )
        await Task.detached { callbacks.invoke() }.value
        await fulfillment(of: [audioDelivered, resultDelivered], timeout: 3)
    }

    func testCancellingFinalizationDoesNotSendTranscript() async throws {
        let dictation = VoiceDictation(fixture: "Hello")
        dictation.begin()
        try await Task.sleep(for: .milliseconds(200))
        let completion = Task { await dictation.finish() }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(dictation.phase, .transcribing)
        dictation.cancel()
        let outcome = await completion.value
        guard case .empty = outcome else {
            return XCTFail("Cancelled dictation must not send a message")
        }
        XCTAssertEqual(dictation.phase, .idle)
    }
}

// These SDK block types predate Sendable. Each immutable callback is deliberately
// created on MainActor and invoked once off-actor, as AVFoundation/Speech do.
private final class BackgroundCallbacks: @unchecked Sendable {
    let audio: AVAudioNodeTapBlock
    let recognition: (SFSpeechRecognitionResult?, Error?) -> Void
    init(audio: @escaping AVAudioNodeTapBlock, recognition: @escaping (SFSpeechRecognitionResult?, Error?) -> Void) {
        self.audio = audio
        self.recognition = recognition
    }
    func invoke() {
        let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 256)!
        buffer.frameLength = 256
        for index in 0..<256 { buffer.floatChannelData![0][index] = 0.1 }
        audio(buffer, AVAudioTime(sampleTime: 0, atRate: 16_000))
        recognition(nil, NSError(domain: "VoiceCallbackRegression", code: 1))
    }
}
