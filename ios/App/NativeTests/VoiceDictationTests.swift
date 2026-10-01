import XCTest
import AVFoundation
@testable import Instant

@MainActor
final class VoiceDictationTests: XCTestCase {
    func testPhysicalMicrophoneRecordsAClipAndCanRestart() async throws {
        guard ProcessInfo.processInfo.environment["IMPO_VOICE_HARDWARE_QA"] == "1",
              Bundle.main.bundleIdentifier == "ai.impo.voiceqa" else {
            throw XCTSkip("Opt-in real microphone test in the isolated QA app")
        }
        XCTAssertEqual(AVAudioApplication.shared.recordPermission, .granted)
        let dictation = VoiceDictation(fixture: nil)
        let previousHaptics = AVAudioSession.sharedInstance().allowHapticsAndSystemSoundsDuringRecording
        defer { dictation.cancel() }
        for attempt in 0..<3 {
            dictation.begin()
            try await Task.sleep(for: .seconds(4))
            XCTAssertEqual(dictation.phase, .recording)
            XCTAssertTrue(AVAudioSession.sharedInstance().allowHapticsAndSystemSoundsDuringRecording,
                          "Slide-to-cancel haptics must remain available while recording")
            XCTAssertTrue(dictation.levels.contains { $0 > 0 }, "Real microphone samples must reach the UI")
            if attempt == 1 {
                // The QA operator speaks during this hold; silence is reported as `.empty`.
                if case .clip(let clip) = await dictation.finish() {
                    XCTAssertEqual(clip.mimeType, "audio/mp4")
                    XCTAssertGreaterThan(clip.data.count, 1000)
                }
            } else {
                dictation.cancel()
            }
            XCTAssertEqual(dictation.phase, .idle)
            XCTAssertEqual(AVAudioSession.sharedInstance().allowHapticsAndSystemSoundsDuringRecording, previousHaptics)
        }
    }

    func testReleasedHoldReturnsAClipForServerTranscription() async throws {
        let dictation = VoiceDictation(fixture: "Hello")
        dictation.begin()
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(dictation.phase, .recording)
        let outcome = await dictation.finish()
        XCTAssertEqual(outcome, .clip(VoiceClip(data: Data(), mimeType: "audio/mp4", fixtureTranscript: "Hello")))
        XCTAssertEqual(dictation.phase, .idle)
    }

    func testCancelledHoldProducesNoClip() async throws {
        let dictation = VoiceDictation(fixture: "Hello")
        dictation.begin()
        try await Task.sleep(for: .milliseconds(200))
        dictation.cancel()
        let outcome = await dictation.finish()
        XCTAssertEqual(outcome, .empty, "Cancelled dictation must not send a message")
        XCTAssertEqual(dictation.phase, .idle)
    }
}
