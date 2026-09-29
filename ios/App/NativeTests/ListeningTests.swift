import Foundation
import XCTest
import InstantClient
import ActivityKit
@testable import Instant

@MainActor
final class ListeningTests: XCTestCase {
    func testAudioQueueSurvivesReopenAndStaysScopedToAccount() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try ListeningStore(scope: "server|alice", root: root)
        let item = PendingRecording(id: UUID().uuidString, startedAt: Date(timeIntervalSince1970: 10),
                                    endedAt: Date(timeIntervalSince1970: 15), hasSpeech: true, ready: true)
        try store.save(item)
        try Data([1, 2, 3]).write(to: store.audioURL(item.id))
        let reopened = try ListeningStore(scope: "server|alice", root: root)
        XCTAssertEqual(try reopened.recordings(), [item])
        let otherUser = try ListeningStore(scope: "server|bob", root: root)
        let otherServer = try ListeningStore(scope: "other|alice", root: root)
        XCTAssertTrue(try otherUser.recordings().isEmpty)
        XCTAssertTrue(try otherServer.recordings().isEmpty)
        XCTAssertEqual(try reopened.directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        try reopened.remove(item.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.audioURL(item.id).path))
        XCTAssertTrue(try reopened.recordings().isEmpty)
    }

    func testUnresponsiveAudioSetupTimesOutAndLateCompletionIsHarmless() async throws {
        let task = Task.detached { () throws -> String in
            // Model an OS call that doesn't cooperate with cancellation.
            await withCheckedContinuation { continuation in
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { continuation.resume(returning: "late") }
            }
        }
        let started = Date()
        do { _ = try await listeningDeadline(task, seconds: 0.05); XCTFail("Expected timeout") }
        catch let error as URLError { XCTAssertEqual(error.code, .timedOut) }
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.4)
        XCTAssertTrue(task.isCancelled)
        _ = try await task.value
    }

    func testSpeechGateRequiresConsecutiveSpeechInsteadOfLoudness() {
        var gate = ListeningSpeechGate()
        for _ in 0..<1200 { gate.sample(probability: 0.01, frames: 512) }
        XCTAssertFalse(gate.hasSpeech)
        gate.sample(probability: .nan, frames: 512)
        gate.sample(probability: 0.9, frames: 512)
        gate.sample(probability: 0.1, frames: 512)
        gate.sample(probability: 0.9, frames: 512)
        gate.sample(probability: 0.9, frames: 512)
        XCTAssertFalse(gate.hasSpeech)
        gate.sample(probability: 0.9, frames: 512)
        XCTAssertTrue(gate.hasSpeech)
    }

    func testOldActivityStopCannotStopNewerRecording() async throws {
        let model = ListeningModel()
        model.previewListeningActivity()
        let first = try XCTUnwrap(model.listeningSessionID)
        model.stop()
        model.previewListeningActivity()
        let second = try XCTUnwrap(model.listeningSessionID)
        XCTAssertNotEqual(first, second)
        let old = StopListeningIntent(sessionID: first.uuidString)
        _ = try await old.perform()
        XCTAssertTrue(model.isRecording)
        let current = StopListeningIntent(sessionID: second.uuidString)
        _ = try await current.perform()
        XCTAssertFalse(model.isRecording)
        XCTAssertNil(model.listeningSessionID)
        XCTAssertFalse(Activity<ListeningActivityAttributes>.activities.contains { $0.attributes.sessionID == second.uuidString })
    }

    func testLateHistoryResponseCannotRestoreDeletedTranscript() async throws {
        HistoryProtocol.fixture.prepare(pages: [historyPage(id: "deleted"), historyPage(id: "deleted")], holdSecond: true)
        let (model, session, root) = try historyModel()
        defer { session.invalidateAndCancel(); try? FileManager.default.removeItem(at: root) }
        await model.refreshHistory()
        let deleted = try XCTUnwrap(model.history.first)
        let refresh = Task { await model.refreshHistory() }
        for _ in 0..<100 where !HistoryProtocol.fixture.isWaiting { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(HistoryProtocol.fixture.isWaiting)
        let success = await model.delete(deleted)
        XCTAssertTrue(success)
        HistoryProtocol.fixture.release()
        await refresh.value
        XCTAssertTrue(model.history.isEmpty, "A pre-delete response must not restore a transcript")
    }

    func testHistoryRefreshKeepsNewGapReachableThroughPagination() async throws {
        HistoryProtocol.fixture.prepare(pages: [historyPage(id: "old"), historyPage(id: "new", cursor: "new-gap")])
        let (model, session, root) = try historyModel()
        defer { session.invalidateAndCancel(); try? FileManager.default.removeItem(at: root) }
        await model.refreshHistory()
        XCTAssertNil(model.historyCursor)
        await model.refreshHistory()
        XCTAssertEqual(model.history.map(\.id), ["new"])
        XCTAssertEqual(model.historyCursor, "new-gap")
    }

    private func historyModel() throws -> (ListeningModel, URLSession, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [HistoryProtocol.self]
        let session = URLSession(configuration: config)
        let model = ListeningModel(storageRoot: root, observeNetwork: false)
        model.configure(scope: "history-test", client: InstantClient(baseURL: URL(string: "https://history.invalid")!, bearerToken: "test", session: session))
        return (model, session, root)
    }

    private func historyPage(id: String, cursor: String? = nil) -> Data {
        try! JSONSerialization.data(withJSONObject: ["segments": [["id": id, "clientSegmentId": id,
            "startedAt": "2026-09-27T00:00:00Z", "endedAt": "2026-09-27T00:00:05Z", "status": "transcribed", "transcript": "Test transcript"]],
            "nextCursor": cursor as Any? ?? NSNull()])
    }

    func testRejectedUploadKeepsAudioAndChangingAccountDoesNotUploadIt() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ListeningQueueProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let model = ListeningModel(storageRoot: root, observeNetwork: false)
        let scope = "test|alice"
        let storage = try ListeningStore(scope: scope, root: root)
        let item = PendingRecording(id: UUID().uuidString, startedAt: Date().addingTimeInterval(-10), endedAt: Date(), hasSpeech: true, ready: true)
        try storage.save(item); try Data([1, 2, 3]).write(to: storage.audioURL(item.id))
        model.configure(scope: scope, client: InstantClient(baseURL: URL(string: "https://fail.listening.invalid")!, bearerToken: "alice", session: session))
        await model.sync()
        XCTAssertNotNil(model.uploadError)
        XCTAssertEqual(model.pending, [item])
        XCTAssertTrue(FileManager.default.fileExists(atPath: storage.audioURL(item.id).path))
        model.configure(scope: "test|bob", client: InstantClient(baseURL: URL(string: "https://success.listening.invalid")!, bearerToken: "bob", session: session))
        await model.sync()
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertEqual(try storage.recordings(), [item])
        model.configure(scope: scope, client: InstantClient(baseURL: URL(string: "https://success.listening.invalid")!, bearerToken: "alice", session: session))
        await model.sync()
        XCTAssertNil(model.uploadError)
        XCTAssertTrue(try storage.recordings().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: storage.audioURL(item.id).path))
    }
}

private final class HistoryProtocol: URLProtocol, @unchecked Sendable {
    static let fixture = HistoryFixture()
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "history.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.httpMethod == "DELETE" { reply(Data("{\"status\":\"deleted\"}".utf8)); return }
        Self.fixture.respond(to: self)
    }
    func reply(_ data: Data) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class HistoryFixture: @unchecked Sendable {
    private let lock = NSLock()
    private var pages: [Data] = []
    private var count = 0
    private var holdSecond = false
    private var waiting: (HistoryProtocol, Data)?
    var isWaiting: Bool { lock.withLock { waiting != nil } }
    func prepare(pages: [Data], holdSecond: Bool = false) {
        lock.withLock { self.pages = pages; self.holdSecond = holdSecond; count = 0; waiting = nil }
    }
    func respond(to protocolInstance: HistoryProtocol) {
        let data: Data? = lock.withLock {
            let data = pages[min(count, pages.count - 1)]; count += 1
            if holdSecond && count == 2 { waiting = (protocolInstance, data); return nil }
            return data
        }
        if let data { protocolInstance.reply(data) }
    }
    func release() {
        let pending = lock.withLock { let pending = waiting; waiting = nil; return pending }
        if let pending { pending.0.reply(pending.1) }
    }
}

private final class ListeningQueueProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".listening.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let upload = request.httpMethod == "POST"
        let fail = upload && request.url?.host == "fail.listening.invalid"
        if upload { XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer alice", "Bob must never upload Alice's audio") }
        let payload = listeningTestRequestBody(request)
        let body: [String: Any] = fail ? ["error": ["code": "unavailable", "message": "retry", "retryable": true]]
            : upload ? ["batchId":payload["batchId"]!,"streamId":payload["streamId"]!,"sequence":payload["sequence"]!,"status":"accepted"]
            : ["segments": []]
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: fail ? 503 : upload ? 202 : 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
