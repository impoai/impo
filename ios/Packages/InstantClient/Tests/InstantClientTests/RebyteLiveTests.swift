import Foundation
import XCTest
@testable import InstantClient

private enum RebyteLiveTestError: LocalizedError {
    case invalidOrigin
    case timeout
    case terminalStatus(String)

    var errorDescription: String? {
        switch self {
        case .invalidOrigin:
            return "INSTANT_LIVE_BASE_URL must be an HTTP(S) origin without /api/v1, credentials, query or fragment"
        case .timeout:
            return "Swift live round trip exceeded 120 seconds"
        case .terminalStatus(let status):
            return "Live submission ended with status \(status)"
        }
    }
}

@MainActor
final class RebyteLiveTests: XCTestCase {
    func testRealReplyAndReplayKeepStableIdentity() async throws {
        guard let origin = ProcessInfo.processInfo.environment["INSTANT_LIVE_BASE_URL"] else {
            throw XCTSkip("Set INSTANT_LIVE_BASE_URL to run the real Rebyte round trip through Instant API")
        }
        guard let components = URLComponents(string: origin),
              ["http", "https"].contains(components.scheme ?? ""),
              let host = components.host, !host.isEmpty,
              components.path.isEmpty || components.path == "/",
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              let url = components.url else {
            throw RebyteLiveTestError.invalidOrigin
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForResource = 120
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        // Only an Instant development identity reaches Swift. Rebyte credentials stay on the server.
        let client = InstantClient(baseURL: url, bearerToken: "instant-dev-bob", session: session)

        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await Self.roundTrip(client) }
            group.addTask {
                try await Task.sleep(for: .seconds(120))
                throw RebyteLiveTestError.timeout
            }
            defer { group.cancelAll() }
            _ = try await group.next()
        }
    }

    nonisolated private static func roundTrip(_ client: InstantClient) async throws {
        let marker = "INSTANT_SWIFT_OK"
        let receipt = try await client.sendMessage(
            clientMessageId: UUID().uuidString,
            text: "Reply exactly \(marker), with no other text."
        )

        // Poll independently of SSE so model latency does not depend on a live HTTP subscription.
        var completed: Submission
        while true {
            try Task.checkCancellation()
            let snapshot = try await client.submission(receipt.submissionId)
            if snapshot.status == "completed" { completed = snapshot; break }
            if snapshot.status == "failed" || snapshot.status == "cancelled" {
                throw RebyteLiveTestError.terminalStatus(snapshot.status)
            }
            try await Task.sleep(for: .milliseconds(200))
        }

        let first = try await collect(client, id: receipt.submissionId)
        XCTAssertTrue(first.text.contains(marker), "The real model reply must contain the requested live-test marker")
        XCTAssertEqual(first.status, "completed")
        XCTAssertEqual(first.submissionId, receipt.submissionId)
        XCTAssertEqual(first.messageId, completed.messageId)
        XCTAssertNotEqual(first.messageId, receipt.messageId, "The receipt identifies the user message; the stream identifies the assistant reply")
        XCTAssertTrue(first.finished)
        XCTAssertTrue(first.done)
        XCTAssertFalse(first.aborted)
        XCTAssertTrue(first.errors.isEmpty)

        let replay = try await collect(client, id: receipt.submissionId)
        XCTAssertEqual(replay, first, "Reconnection must reconstruct the same reply without duplicate text or new IDs")
        XCTAssertTrue(replay.done)
        let final = try await client.submission(receipt.submissionId)
        XCTAssertEqual(final.status, "completed")
        XCTAssertEqual(final.messageId, first.messageId)
    }

    nonisolated private static func collect(_ client: InstantClient, id: String) async throws -> UIMessageState {
        var result = UIMessageState()
        for try await state in client.stream(submissionId: id) {
            try Task.checkCancellation()
            result = state
        }
        return result
    }
}
