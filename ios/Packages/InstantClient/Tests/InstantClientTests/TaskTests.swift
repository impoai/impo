import Foundation
import XCTest
@testable import InstantClient

final class TaskTests: XCTestCase {
    func testListDecodesStatusAndOptionalRunTimes() async throws {
        let (client, session) = fixture("list")
        defer { session.invalidateAndCancel() }
        let tasks = try await client.tasks()
        XCTAssertEqual(tasks.map(\.status), ["in_progress", "completed"])
        XCTAssertEqual(tasks[0].title, "Plan my meals")
        XCTAssertNil(tasks[0].lastRunCompletedAt)
        XCTAssertEqual(tasks[0].updatedAt, "2026-09-27T09:05:00Z")
        XCTAssertNil(tasks[1].updatedAt, "Older servers remain compatible")
        XCTAssertEqual(tasks[1].lastRunCompletedAt, "2026-09-27T08:00:38Z")
    }

    func testCreatePostsMessageFieldsAndDecodesReceipt() async throws {
        let (client, session) = fixture("create")
        defer { session.invalidateAndCancel() }
        let receipt = try await client.createTask(clientMessageId: "client-1", text: "Plan my meals",
            clientContext: MessageClientContext(timeZone: "Asia/Shanghai", currentDate: "2026-09-27T08:00:00Z"))
        XCTAssertEqual(receipt, TaskReceipt(taskId: "11111111-1111-4111-8111-111111111111", conversationId: "conv", messageId: "msg", submissionId: "sub"))
    }

    func testConversationUsesTaskPathAndPagingQuery() async throws {
        let (client, session) = fixture("conversation")
        defer { session.invalidateAndCancel() }
        let page = try await client.taskConversation("11111111-1111-4111-8111-111111111111", afterSequence: 2, limit: 50)
        XCTAssertEqual(page.title, "Plan my meals")
        XCTAssertEqual(page.messages.map(\.role), ["user", "assistant"])
        XCTAssertEqual(page.activeSubmissions.first?.submissionId, "sub")
    }

    func testFollowUpPostsToTaskMessages() async throws {
        let (client, session) = fixture("message")
        defer { session.invalidateAndCancel() }
        let receipt = try await client.sendTaskMessage("11111111-1111-4111-8111-111111111111", clientMessageId: "client-2", text: "hi")
        XCTAssertEqual(receipt, MessageReceipt(messageId: "msg-2", submissionId: "sub-2"))
    }

    private func fixture(_ scenario: String) -> (InstantClient, URLSession) {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [TaskFixtureProtocol.self]
        let session = URLSession(configuration: config)
        return (InstantClient(baseURL: URL(string: "https://\(scenario).task-test.invalid")!, bearerToken: "swift-task-test", session: session), session)
    }
}

/// Each request carries its scenario in its test-only origin, so concurrent tests share no state.
private final class TaskFixtureProtocol: URLProtocol, @unchecked Sendable {
    private static let taskId = "11111111-1111-4111-8111-111111111111"
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".task-test.invalid") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let scenario = String(request.url!.host!.split(separator: ".")[0])
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer swift-task-test")
            let body: [String: Any]
            var status = 200
            switch scenario {
            case "list":
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/api/v1/tasks")
                body = ["tasks": [
                    ["taskId": "a", "conversationId": "ca", "title": "Plan my meals", "status": "in_progress", "createdAt": "2026-09-27T08:00:00Z", "updatedAt": "2026-09-27T09:05:00Z", "lastRunStartedAt": "2026-09-27T08:00:00Z", "lastRunCompletedAt": NSNull()],
                    ["taskId": "b", "conversationId": "cb", "title": "Weekly update", "status": "completed", "createdAt": "2026-09-27T08:00:00Z", "lastRunStartedAt": "2026-09-27T08:00:00Z", "lastRunCompletedAt": "2026-09-27T08:00:38Z"],
                ]]
            case "create":
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.url?.path, "/api/v1/tasks")
                let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(requestData())) as? [String: Any])
                XCTAssertEqual(Set(sent.keys), ["clientMessageId", "text", "clientContext"])
                XCTAssertEqual(sent["text"] as? String, "Plan my meals")
                XCTAssertEqual((sent["clientContext"] as? [String: String])?["timeZone"], "Asia/Shanghai")
                status = 202
                body = ["taskId": Self.taskId, "conversationId": "conv", "messageId": "msg", "submissionId": "sub"]
            case "conversation":
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/api/v1/tasks/\(Self.taskId)/conversation")
                XCTAssertEqual(request.url?.query, "afterSequence=2&limit=50")
                body = ["taskId": Self.taskId, "title": "Plan my meals", "conversationId": "conv", "hasMore": false, "nextAfterSequence": 4,
                        "activeSubmissions": [["submissionId": "sub", "messageId": "m2", "status": "running"]],
                        "messages": [
                            ["id": "m1", "role": "user", "sequence": 3, "text": "Plan my meals", "status": "completed", "createdAt": "2026-09-27T08:00:00Z"],
                            ["id": "m2", "role": "assistant", "sequence": 4, "text": "", "status": "streaming", "createdAt": "2026-09-27T08:00:00Z"],
                        ]]
            default:
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.url?.path, "/api/v1/tasks/\(Self.taskId)/messages")
                let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(requestData())) as? [String: Any])
                XCTAssertEqual(Set(sent.keys), ["clientMessageId", "text"])
                status = 202
                body = ["messageId": "msg-2", "submissionId": "sub-2"]
            }
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: body))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}

    private func requestData() throws -> Data? {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var bytes = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&bytes, maxLength: bytes.count)
            if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
            if count == 0 { break }
            data.append(contentsOf: bytes.prefix(count))
        }
        return data
    }
}
