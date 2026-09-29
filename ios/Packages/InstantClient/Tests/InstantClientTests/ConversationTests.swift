import Foundation
import XCTest
@testable import InstantClient

final class ConversationTests: XCTestCase {
    func testHistoryPaginationPreservesUnicodeIdentityAndTerminalStates() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ConversationURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = InstantClient(baseURL: URL(string: "http://instant-history.test")!, bearerToken: "history-test", session: session)

        let first = try await client.conversation(limit: 2)
        XCTAssertEqual(first.conversationId, "conversation-1")
        XCTAssertEqual(first.messages.map(\.id), ["user-1", "assistant-1"])
        XCTAssertEqual(first.messages.map(\.sequence), [1, 2])
        XCTAssertEqual(first.messages[0].text, "你好 👋")
        XCTAssertEqual(first.messages[1].status, "failed")
        XCTAssertTrue(first.hasMore)
        XCTAssertEqual(first.nextAfterSequence, 2)

        let second = try await client.conversation(afterSequence: first.nextAfterSequence, limit: 2)
        XCTAssertEqual(second.conversationId, first.conversationId)
        XCTAssertEqual(second.messages.map(\.id), ["user-2", "assistant-2"])
        XCTAssertEqual(second.messages[1].status, "cancelled")
        XCTAssertEqual(second.activeSubmissions.map(\.submissionId), ["run-3", "run-4"])
        XCTAssertEqual(second.activeSubmissions.map(\.status), ["running", "queued"])
        XCTAssertEqual(second.activeSubmissions[0].messageId, "assistant-3")
        XCTAssertFalse(second.hasMore)
        XCTAssertEqual(second.nextAfterSequence, 4)
    }
}

/// Deterministic transport fixture with no shared mutable URLProtocol state.
private final class ConversationURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "instant-history.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url,
              request.httpMethod == "GET", url.path == "/api/v1/conversation",
              request.value(forHTTPHeaderField: "Authorization") == "Bearer history-test",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.queryItems?.first(where: { $0.name == "limit" })?.value == "2",
              let after = components.queryItems?.first(where: { $0.name == "afterSequence" })?.value,
              ["0", "2"].contains(after) else {
            client?.urlProtocol(self, didFailWithError: InstantClientError.invalidResponse)
            return
        }
        let body: String
        if after == "0" {
            body = #"{"conversationId":"conversation-1","messages":[{"id":"user-1","role":"user","sequence":1,"text":"你好 👋","status":"completed","createdAt":"2026-09-22T00:00:00.000Z"},{"id":"assistant-1","role":"assistant","sequence":2,"text":"","status":"failed","createdAt":"2026-09-22T00:00:00.000Z","parts":[]}],"activeSubmissions":[],"hasMore":true,"nextAfterSequence":2}"#
        } else {
            body = #"{"conversationId":"conversation-1","messages":[{"id":"user-2","role":"user","sequence":3,"text":"Try again","status":"completed","createdAt":"2026-09-22T00:01:00.000Z"},{"id":"assistant-2","role":"assistant","sequence":4,"text":"Partial reply","status":"cancelled","createdAt":"2026-09-22T00:01:00.000Z"}],"activeSubmissions":[{"submissionId":"run-3","messageId":"assistant-3","status":"running"},{"submissionId":"run-4","messageId":"assistant-4","status":"queued"}],"hasMore":false,"nextAfterSequence":4}"#
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
