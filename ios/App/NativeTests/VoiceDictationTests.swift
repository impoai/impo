import XCTest
@testable import Instant

@MainActor
final class VoiceDictationTests: XCTestCase {
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
