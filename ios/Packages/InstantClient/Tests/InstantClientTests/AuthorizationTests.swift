import Foundation
import XCTest
@testable import InstantClient

final class AuthorizationTests: XCTestCase {
    func testJSONCommandRefreshesOnceAndKeepsIdempotencyBody() async throws {
        let f = Fixture("command")
        defer { f.session.invalidateAndCancel() }
        let result = try await f.client.sendMessage(clientMessageId: "stable-message", text: "Hello")
        XCTAssertEqual(result.submissionId, "run")
        let requests = AuthProtocol.recorded(f.host)
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests.map { $0.value(forHTTPHeaderField: "Authorization") }, ["Bearer old", "Bearer fresh"])
        XCTAssertEqual(body(requests[0]), body(requests[1]))
        let refreshes = await f.provider.refreshes
        XCTAssertEqual(refreshes, ["old"])
    }

    func testBatchUploadRefreshesWithoutChangingPayload() async throws {
        let f = Fixture("batch")
        defer { f.session.invalidateAndCancel() }
        let payload = Data(#"{"batchId":"stable-batch","streamId":"stable-stream","sequence":7,"items":[]}"#.utf8)
        _ = try await f.client.uploadListeningBatch(payload)
        XCTAssertEqual(AuthProtocol.recorded(f.host).map(body), [payload, payload])
    }

    func testRawAudioUploadRefreshesAndKeepsMetadata() async throws {
        let f = Fixture("audio")
        defer { f.session.invalidateAndCancel() }
        _ = try await f.client.uploadListeningSegment(id: "same-segment", startedAt: Date(timeIntervalSince1970: 1), endedAt: Date(timeIntervalSince1970: 3), audio: Data([1,2,3]))
        let requests = AuthProtocol.recorded(f.host)
        XCTAssertEqual(requests.map(body), [Data([1,2,3]), Data([1,2,3])])
        XCTAssertEqual(requests.map { $0.value(forHTTPHeaderField: "X-Client-Segment-Id") }, ["same-segment", "same-segment"])
    }

    func testStreamRefreshesBeforeConsumingEvents() async throws {
        let f = Fixture("stream")
        defer { f.session.invalidateAndCancel() }
        var count = 0
        for try await _ in f.client.stream(submissionId: "run") { count += 1 }
        XCTAssertGreaterThan(count, 0)
        XCTAssertEqual(AuthProtocol.recorded(f.host).count, 2)
        let refreshes = await f.provider.refreshes
        XCTAssertEqual(refreshes, ["old"])
    }

    func testPersistent401IsReportedAfterOneRetry() async throws {
        let f = Fixture("always401")
        defer { f.session.invalidateAndCancel() }
        do { _ = try await f.client.conversation(); XCTFail("Expected rejection") }
        catch let error as InstantAPIError { XCTAssertEqual(error.statusCode, 401) }
        XCTAssertEqual(AuthProtocol.recorded(f.host).count, 2)
        let refreshes = await f.provider.refreshes
        XCTAssertEqual(refreshes.count, 1)
    }

    func testNonAuthFailuresDoNotRefreshOrReplay() async throws {
        for status in [403,408,429,500] {
            let f = Fixture("status\(status)")
            defer { f.session.invalidateAndCancel() }
            do { _ = try await f.client.conversation(); XCTFail("Expected rejection") }
            catch let error as InstantAPIError { XCTAssertEqual(error.statusCode, status) }
            XCTAssertEqual(AuthProtocol.recorded(f.host).count, 1)
            let refreshes = await f.provider.refreshes
            XCTAssertTrue(refreshes.isEmpty)
        }
    }

    func testFileTransferClosureUsesSameRefreshPolicy() async throws {
        let f = Fixture("file")
        defer { f.session.invalidateAndCancel() }
        var request = try await f.client.listeningBatchUploadRequest()
        request.allowsCellularAccess = false
        let attempts = AttemptRecorder()
        try await f.client.retryingAuthorization(for: request) { current in
            await attempts.add(current)
            if current.value(forHTTPHeaderField: "Authorization") == "Bearer old" {
                throw InstantClientError.unexpectedHTTPStatus(401)
            }
        }
        let recorded = await attempts.requests
        XCTAssertEqual(recorded.count, 2)
        XCTAssertEqual(recorded.first?.url, recorded.last?.url)
        XCTAssertFalse(try XCTUnwrap(recorded.last).allowsCellularAccess)
    }

    func testCancellationDoesNotTriggerRefresh() async throws {
        let f = Fixture("cancel")
        defer { f.session.invalidateAndCancel() }
        let request = try await f.client.listeningBatchUploadRequest()
        let task = Task {
            try await f.client.retryingAuthorization(for: request) { _ in
                withUnsafeCurrentTask { $0?.cancel() }
                throw InstantClientError.unexpectedHTTPStatus(401)
            } as Void
        }
        do { try await task.value; XCTFail("Expected cancellation") } catch is CancellationError {}
        let refreshes = await f.provider.refreshes
        XCTAssertTrue(refreshes.isEmpty)
    }
}

private actor AttemptRecorder {
    var requests: [URLRequest] = []
    func add(_ request: URLRequest) { requests.append(request) }
}
private actor RefreshProvider: InstantTokenProvider {
    var refreshes: [String] = []
    func token() -> String { "old" }
    func refreshToken(rejectedToken: String) -> String { refreshes.append(rejectedToken); return "fresh" }
}
private struct Fixture: Sendable {
    let host: String
    let session: URLSession
    let client: InstantClient
    let provider = RefreshProvider()
    init(_ scenario: String) {
        host = "\(scenario)-\(UUID().uuidString.lowercased()).auth.invalid"
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AuthProtocol.self]
        session = URLSession(configuration: config)
        client = InstantClient(baseURL: URL(string: "https://\(host)")!, tokenProvider: provider, session: session)
    }
}
private func body(_ request: URLRequest) -> Data {
    if let data = request.httpBody { return data }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open(); defer { stream.close() }
    var result = Data(); var bytes = [UInt8](repeating: 0, count: 4096)
    while true {
        let count = stream.read(&bytes, maxLength: bytes.count)
        if count <= 0 { break }
        result.append(contentsOf: bytes.prefix(count))
    }
    return result
}
private final class AuthProtocol: URLProtocol, @unchecked Sendable {
    private static let state = Records()
    private final class Records: @unchecked Sendable {
        let lock = NSLock()
        var requests: [String: [URLRequest]] = [:]
    }
    static func recorded(_ host: String) -> [URLRequest] { state.lock.withLock { state.requests[host] ?? [] } }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".auth.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        let host = request.url!.host!
        var copy = request; copy.httpBody = body(request)
        Self.state.lock.withLock { Self.state.requests[host, default: []].append(copy) }
        let scenario = String(host.split(separator: "-")[0])
        let old = request.value(forHTTPHeaderField: "Authorization") == "Bearer old"
        let status = scenario.hasPrefix("status") ? Int(scenario.dropFirst(6))! : old || scenario == "always401" ? 401 : ["batch","audio"].contains(scenario) ? 202 : 200
        let response: String
        var headers = ["Content-Type":"application/json"]
        if status >= 400 { response = #"{"error":{"code":"rejected","message":"Rejected","retryable":false},"requestId":"test"}"# }
        else if scenario == "stream" {
            headers = ["Content-Type":"text/event-stream", "x-vercel-ai-ui-message-stream":"v1"]
            response = "data: {\"type\":\"start\",\"messageId\":\"m\"}\n\ndata: {\"type\":\"finish\"}\n\ndata: [DONE]\n\n"
        } else if scenario == "batch" { response = #"{"batchId":"stable-batch","streamId":"stable-stream","sequence":7,"status":"accepted"}"# }
        else if scenario == "audio" { response = #"{"id":"segment","clientSegmentId":"same-segment","startedAt":"1970-01-01T00:00:01Z","endedAt":"1970-01-01T00:00:03Z","status":"pending","transcript":""}"# }
        else { response = #"{"messageId":"m","submissionId":"run"}"# }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(response.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
