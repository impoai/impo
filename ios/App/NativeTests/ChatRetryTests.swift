import Foundation
import XCTest
@testable import Instant

@MainActor
final class ChatRetryTests: XCTestCase {
    func testAcknowledgedFailedCalendarReplyRetriesAsNewMessage() async throws {
        let fixture = ChatFixture(scenario: .failedHistory)
        defer { fixture.close() }
        let model = fixture.model
        await model.restoreConversation()
        XCTAssertNotNil(model.chatError)
        XCTAssertTrue(ChatRetryProtocol.state(fixture.host).posts.isEmpty)
        model.retry()
        // A second tap while submission is in flight must not create another.
        model.retry()
        try await settled(model)
        let posts = ChatRetryProtocol.state(fixture.host).posts
        XCTAssertEqual(posts.count, 1)
        XCTAssertEqual(posts[0]["text"] as? String, "看看我的日历")
        XCTAssertNotEqual(posts[0]["clientMessageId"] as? String, "original-client-id")
        XCTAssertNotNil(posts[0]["clientContext"])
        XCTAssertNil(model.chatError)
        XCTAssertEqual(model.messages.last?.text, "今天没有日历安排。")
    }

    func testLostAcknowledgementRetryKeepsOriginalIdentityAcrossReopen() async throws {
        let fixture = ChatFixture(scenario: .lostAcknowledgement)
        defer { fixture.close() }
        XCTAssertTrue(fixture.model.send("看看我的日历"))
        try await settled(fixture.model)
        XCTAssertNotNil(fixture.model.chatError)
        let first = ChatRetryProtocol.state(fixture.host).posts
        XCTAssertEqual(first.count, 4, "Initial submission and three automatic retries")
        ChatRetryProtocol.allowRecovery(fixture.host)
        fixture.model.suspendStream()
        let reopened = AppModel(defaults: fixture.defaults, session: fixture.session)
        defer { reopened.suspendStream() }
        reopened.retry()
        try await settled(reopened)
        let all = ChatRetryProtocol.state(fixture.host).posts
        XCTAssertEqual(all.count, 5)
        let original = try JSONSerialization.data(withJSONObject: all[0], options: .sortedKeys)
        for post in all.dropFirst() {
            XCTAssertEqual(try JSONSerialization.data(withJSONObject: post, options: .sortedKeys), original,
                           "Automatic retries and a manual retry after reopening must preserve the entire command")
        }
        XCTAssertNil(reopened.chatError)
    }

    func testHistoryConnectionFailureOnlyReconnectsWithoutNewInput() async throws {
        let fixture = ChatFixture(scenario: .historyUnavailable)
        defer { fixture.close() }
        await fixture.model.restoreConversation()
        XCTAssertNotNil(fixture.model.chatError)
        ChatRetryProtocol.allowRecovery(fixture.host)
        fixture.model.retry()
        try await settled(fixture.model)
        XCTAssertTrue(ChatRetryProtocol.state(fixture.host).posts.isEmpty)
        XCTAssertNil(fixture.model.chatError)
    }

    func testOldFailedReplyDoesNotOverrideNewSuccessfulReply() async throws {
        let fixture = ChatFixture(scenario: .successAfterFailure)
        defer { fixture.close() }
        await fixture.model.restoreConversation()
        XCTAssertNil(fixture.model.chatError)
        XCTAssertEqual(fixture.model.messages.last?.text, "今天没有日历安排。")
        XCTAssertTrue(ChatRetryProtocol.state(fixture.host).posts.isEmpty)
    }

    func testRetryThatFailsAgainCanBeRetriedAsAnotherDistinctAttempt() async throws {
        let fixture = ChatFixture(scenario: .repeatedFailure)
        defer { fixture.close() }
        await fixture.model.restoreConversation()
        fixture.model.retry()
        try await settled(fixture.model)
        XCTAssertNotNil(fixture.model.chatError)
        fixture.model.retry()
        try await settled(fixture.model)
        let posts = ChatRetryProtocol.state(fixture.host).posts
        XCTAssertEqual(posts.count, 2)
        XCTAssertNotEqual(posts[0]["clientMessageId"] as? String, posts[1]["clientMessageId"] as? String)
    }

    func testCancelledReplyRetryStartsNewAttempt() async throws {
        let fixture = ChatFixture(scenario: .cancelledHistory)
        defer { fixture.close() }
        await fixture.model.restoreConversation()
        fixture.model.retry()
        try await settled(fixture.model)
        XCTAssertEqual(ChatRetryProtocol.state(fixture.host).posts.count, 1)
        XCTAssertNil(fixture.model.chatError)
    }

    private func settled(_ model: AppModel) async throws {
        for _ in 0..<1500 {
            if !model.isThinking { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Chat did not settle")
    }
}

@MainActor
private final class ChatFixture {
    let host = "chat-" + UUID().uuidString.lowercased() + ".local"
    let suite = "chat-retry-" + UUID().uuidString
    let defaults: UserDefaults
    let session: URLSession
    let model: AppModel
    init(scenario: ChatRetryProtocol.Scenario) {
        defaults = UserDefaults(suiteName: suite)!
        defaults.set(true, forKey: "instant.live")
        defaults.set("http://\(host)", forKey: "instant.backend")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ChatRetryProtocol.self]
        session = URLSession(configuration: configuration)
        ChatRetryProtocol.prepare(host, scenario: scenario)
        model = AppModel(defaults: defaults, session: session)
    }
    func close() {
        model.suspendStream()
        session.invalidateAndCancel()
        defaults.removePersistentDomain(forName: suite)
    }
}

private final class ChatRetryProtocol: URLProtocol, @unchecked Sendable {
    enum Scenario { case failedHistory, cancelledHistory, lostAcknowledgement, historyUnavailable, successAfterFailure, repeatedFailure }
    struct State { let scenario: Scenario; var posts: [[String:Any]] = []; var reads = 0; var recoveryAllowed = false }
    private final class Storage: @unchecked Sendable { let lock = NSLock(); var values: [String:State] = [:] }
    private static let storage = Storage()
    static func prepare(_ host: String, scenario: Scenario) { storage.lock.withLock { storage.values[host] = State(scenario: scenario) } }
    static func state(_ host: String) -> State { storage.lock.withLock { storage.values[host]! } }
    static func allowRecovery(_ host: String) { storage.lock.withLock { storage.values[host]!.recoveryAllowed = true } }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasPrefix("chat-") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        let url = request.url!, host = url.host!, path = url.path
        let json: [String:Any]
        if path == "/api/v1/conversation/messages" {
            let payload = readBody(request)
            let current = Self.storage.lock.withLock { Self.storage.values[host]!.posts.append(payload); return Self.storage.values[host]! }
            if current.scenario == .lostAcknowledgement && !current.recoveryAllowed {
                client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)); return
            }
            json = ["messageId":"new-user", "submissionId":"new-submission"]
        } else if path == "/api/v1/conversation" {
            let current = Self.storage.lock.withLock { Self.storage.values[host]!.reads += 1; return Self.storage.values[host]! }
            if current.scenario == .historyUnavailable && !current.recoveryAllowed {
                client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)); return
            }
            let succeeded = current.scenario == .successAfterFailure || current.scenario == .historyUnavailable || (!current.posts.isEmpty && current.scenario != .repeatedFailure)
            let cancelled = current.scenario == .cancelledHistory && current.posts.isEmpty
            func message(_ id: String, _ role: String, _ sequence: Int, _ text: String, _ status: String) -> [String:Any] {
                ["id":id,"role":role,"sequence":sequence,"text":text,"status":status,"createdAt":"2026-09-29T01:00:00Z"]
            }
            var messages = [message("original-user","user",1,"看看我的日历","completed"),message("original-assistant","assistant",2,"",cancelled ? "cancelled" : "failed")]
            if succeeded {
                messages += [message("new-user","user",3,"看看我的日历","completed"),message("new-assistant","assistant",4,"今天没有日历安排。","completed")]
            }
            json = ["conversationId":"conversation","messages":messages,"activeSubmissions":[],"hasMore":false,"nextAfterSequence":succeeded ? 4 : 2]
        } else if path == "/api/v1/devices/register" { json = ["deviceId":"device"] }
        else if path.contains("tool-invocations") { json = ["invocations":[]] }
        else if path == "/api/v1/connectors" { json = ["connectors":[]] }
        else { client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: json))
        client?.urlProtocolDidFinishLoading(self)
    }
    private func readBody(_ request: URLRequest) -> [String:Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating:0,count:4096)
            while true { let n = stream.read(&buffer,maxLength:buffer.count); if n <= 0 { break }; data.append(contentsOf:buffer.prefix(n)) }
        }
        return (try? JSONSerialization.jsonObject(with:data)) as? [String:Any] ?? [:]
    }
}
