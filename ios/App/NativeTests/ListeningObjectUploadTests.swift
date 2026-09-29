import Foundation
import XCTest
import InstantClient
@testable import Instant

@MainActor
final class ListeningObjectUploadTests: XCTestCase {
    func testLostConfirmationKeepsAudioAndResumesWithoutUploadingAgain() async throws {
        let fixture = try UploadFixture(); defer { fixture.close() }
        fixture.state.failConfirmation = true
        var transfers = 0
        let original = try Data(contentsOf: fixture.queue.payloadURL(fixture.batch.batchId))
        do {
            try await fixture.sync { request, file in
                transfers += 1
                XCTAssertEqual(request.httpMethod, "PUT")
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                XCTAssertTrue(request.allowsCellularAccess)
                XCTAssertEqual(try Data(contentsOf: file), original)
                XCTAssertFalse(try fixture.store.recordings().isEmpty)
                fixture.state.stored = true
            }
            XCTFail("The first API confirmation must fail")
        } catch { }
        XCTAssertEqual(try Data(contentsOf: fixture.queue.payloadURL(fixture.batch.batchId)), original)
        fixture.state.failConfirmation = false
        try await fixture.sync { _, _ in transfers += 1; XCTFail("Stored audio must not upload twice") }
        XCTAssertEqual(transfers, 1)
        XCTAssertTrue(try fixture.store.recordings().isEmpty)
        XCTAssertTrue(try fixture.queue.batches().isEmpty)
        XCTAssertEqual(fixture.state.confirmations, 2)
        XCTAssertFalse(fixture.state.manifests.isEmpty)
        for manifest in fixture.state.manifests {
            let batch = try XCTUnwrap(manifest["batch"] as? [String: Any])
            let items = try XCTUnwrap(batch["items"] as? [[String: Any]])
            XCTAssertNil(items[0]["audio"])
            XCTAssertEqual(items[0]["audioBytes"] as? Int, 512_000)
            XCTAssertEqual(manifest["byteLength"] as? Int, original.count)
        }
    }

    func testRejectedSignedURLKeepsBytesAndNextAttemptGetsFreshURL() async throws {
        let fixture = try UploadFixture(); defer { fixture.close() }
        var urls: [URL] = []
        do {
            try await fixture.sync(wifiOnly: true) { request, _ in
                XCTAssertFalse(request.allowsCellularAccess)
                urls.append(request.url!)
                throw InstantClientError.unexpectedHTTPStatus(403)
            }
            XCTFail("Expired upload address must fail")
        } catch { }
        XCTAssertEqual(try fixture.queue.batches().count, 1)
        XCTAssertEqual(fixture.state.confirmations, 0)
        try await fixture.sync(wifiOnly: true) { request, _ in
            urls.append(request.url!); fixture.state.stored = true
        }
        XCTAssertEqual(urls.count, 2)
        XCTAssertNotEqual(urls[0], urls[1])
        XCTAssertTrue(try fixture.store.recordings().isEmpty)
    }

    func testMismatchedFinalReceiptNeverDeletesLocalAudio() async throws {
        let fixture = try UploadFixture(); defer { fixture.close() }
        fixture.state.wrongReceipt = true
        do {
            try await fixture.sync { _, _ in fixture.state.stored = true }
            XCTFail("Another batch's receipt must be rejected")
        } catch { }
        XCTAssertFalse(try fixture.store.recordings().isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.queue.payloadURL(fixture.batch.batchId).path))
    }

    func testCancellationAfterPUTKeepsAudioForNextLaunch() async throws {
        let fixture = try UploadFixture(); defer { fixture.close() }
        let task = Task {
            try await fixture.sync { _, _ in
                fixture.state.stored = true
                throw CancellationError()
            }
        }
        do { try await task.value; XCTFail("Expected interrupted confirmation") } catch { }
        XCTAssertFalse(try fixture.store.recordings().isEmpty)
        let reopened = ListeningBatchStore(store: try ListeningStore(scope: fixture.scope, root: fixture.root))
        XCTAssertEqual(try reopened.batches().first?.batchId, fixture.batch.batchId)
        try await fixture.sync { _, _ in XCTFail("Resume must use the previously uploaded object") }
        XCTAssertTrue(try fixture.store.recordings().isEmpty)
    }

    func testRealS3BackgroundUploadKeepsLocalFileUntilAPIConfirmation() async throws {
        guard let path = ProcessInfo.processInfo.environment["IMPO_S3_PROBE_PATH"] else {
            throw XCTSkip("Opt-in real S3 signed URL canary")
        }
        struct Probe: Decodable { let ticket: ListeningUploadTicket; let payload: String }
        let probe = try JSONDecoder().decode(Probe.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let payload = try XCTUnwrap(Data(base64Encoded: probe.payload))
        let scope = "s3-canary-" + UUID().uuidString
        let store = try ListeningStore(scope: scope)
        defer { try? FileManager.default.removeItem(at: store.directory) }
        let item = PendingRecording(id: UUID().uuidString.lowercased(), startedAt: Date().addingTimeInterval(-2), endedAt: Date(), hasSpeech: true, ready: true)
        try store.save(item); try Data("local audio canary".utf8).write(to: store.audioURL(item.id))
        let queue = ListeningBatchStore(store: store)
        let batch = try XCTUnwrap(queue.seal(force: true).first)
        // This opt-in transport test uses the exact bytes bound to the supplied signed URL.
        try payload.write(to: queue.payloadURL(batch.batchId), options: .atomic)
        let request = try ListeningObjectUpload.request(probe.ticket, wifiOnly: false)
        let background = ListeningBackgroundUpload(identifier: "ai.impo.s3-probe." + UUID().uuidString)
        try await background.uploadObject(request: request, batch: batch, store: store)
        XCTAssertEqual(try Data(contentsOf: queue.payloadURL(batch.batchId)), payload)
        XCTAssertFalse(try store.recordings().isEmpty, "An S3 200 is not permission to delete local audio")
        // The active app uses the same immutable file through a foreground session.
        try await ListeningObjectUpload.upload(request, file: queue.payloadURL(batch.batchId))
        XCTAssertFalse(try store.recordings().isEmpty)
    }
}

@MainActor
private final class UploadFixture {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let scope = UUID().uuidString
    let store: ListeningStore
    let queue: ListeningBatchStore
    let batch: StoredListeningBatch
    let state: UploadFixtureState
    let session: URLSession
    let client: InstantClient
    init() throws {
        store = try ListeningStore(scope: scope, root: root)
        let item = PendingRecording(id: UUID().uuidString.lowercased(), startedAt: Date().addingTimeInterval(-2), endedAt: Date(), hasSpeech: true, ready: true)
        try store.save(item); try Data(repeating: 67, count: 512_000).write(to: store.audioURL(item.id))
        queue = ListeningBatchStore(store: store)
        batch = try XCTUnwrap(queue.seal(force: true).first)
        state = UploadFixtureState(batch: batch)
        let host = "uploads-" + UUID().uuidString.lowercased() + ".invalid"
        UploadProtocol.register(host, state)
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [UploadProtocol.self]
        session = URLSession(configuration: configuration)
        client = InstantClient(baseURL: URL(string: "https://\(host)")!, bearerToken: "instant-dev-alice", session: session)
    }
    func sync(wifiOnly: Bool = false, transfer: (URLRequest, URL) async throws -> Void) async throws {
        try await ListeningObjectUpload.sync(client: client, batch: batch, store: store, wifiOnly: wifiOnly, transfer: transfer)
    }
    func close() { session.invalidateAndCancel(); try? FileManager.default.removeItem(at: root) }
}

private final class UploadFixtureState: @unchecked Sendable {
    let batch: StoredListeningBatch
    var stored = false; var failConfirmation = false; var wrongReceipt = false
    var preparations = 0; var confirmations = 0; var manifests: [[String: Any]] = []
    init(batch: StoredListeningBatch) { self.batch = batch }
}
private final class UploadProtocol: URLProtocol, @unchecked Sendable {
    private final class Storage: @unchecked Sendable { let lock = NSLock(); var states: [String: UploadFixtureState] = [:] }
    private static let storage = Storage()
    static func register(_ host: String, _ state: UploadFixtureState) { storage.lock.withLock { storage.states[host] = state } }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasPrefix("uploads-") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() { }
    override func startLoading() {
        let state = Self.storage.lock.withLock { Self.storage.states[request.url!.host!]! }
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 4096)
            while true { let n = stream.read(&bytes, maxLength: bytes.count); if n <= 0 { break }; data.append(contentsOf: bytes.prefix(n)) }
        }
        let input = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        var status = 200
        let result: [String: Any]
        if request.url!.path.hasSuffix("/complete") {
            state.confirmations += 1
            if input == nil { status = 400; result = ["error": ["code": "invalid_request", "message": "Expected JSON", "retryable": false]] }
            else if state.failConfirmation { status = 503; result = ["error": ["code": "temporary", "message": "Retry confirmation", "retryable": true]] }
            else { status = 202; result = ["batchId": state.wrongReceipt ? UUID().uuidString : state.batch.batchId, "streamId": state.batch.streamId, "sequence": state.batch.sequence, "status": "accepted"] }
        } else {
            state.preparations += 1; if let input { state.manifests.append(input) }
            result = state.stored ? ["status": "uploaded"] : ["status": "upload", "url": "https://bucket.example.invalid/object?attempt=\(state.preparations)", "headers": ["Content-Type": "application/json"]]
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: result))
        client?.urlProtocolDidFinishLoading(self)
    }
}
