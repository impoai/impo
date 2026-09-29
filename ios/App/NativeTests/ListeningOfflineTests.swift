import AVFoundation
import Foundation
import InstantClient
import XCTest
@testable import Instant

@MainActor
final class ListeningOfflineTests: XCTestCase {
    func testOfflineSpeechSurvivesReopenAndConnectionFailureThenUploadsOnWiFi() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let scope = "offline-" + UUID().uuidString
        let store = try ListeningStore(scope: scope, root: root)
        let writer = ListeningSegmentWriter(store: store, origin: Date().addingTimeInterval(-600))
        try writer.handle(.begin(sample: 0, audio: [Float](repeating: 0.1, count: 16_000), overlap: 0))
        try writer.handle(.end(sample: 16_000))
        let item = try XCTUnwrap(store.recordings().first)
        let bytes = try Data(contentsOf: store.audioURL(item.id))
        XCTAssertTrue(item.ready)
        XCTAssertGreaterThan(bytes.count, 0)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [OfflineUploadProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let client = InstantClient(baseURL: URL(string: "https://offline.listening.invalid")!, bearerToken: "offline-test", session: session)
        OfflineUploadProtocol.fixture.reset()
        let first = ListeningModel(storageRoot: root, observeAudio: false, observeNetwork: false)
        first.configure(scope: scope, client: client)
        await first.sync(force: false)
        XCTAssertEqual(OfflineUploadProtocol.fixture.uploadIDs, [])
        XCTAssertEqual(try Data(contentsOf: store.audioURL(item.id)), bytes)

        let reopened = ListeningModel(storageRoot: root, observeAudio: false, observeNetwork: false)
        reopened.configure(scope: scope, client: client)
        await reopened.sync(force: false)
        XCTAssertEqual(reopened.pending, [item], "A new model recovers the on-disk queue while offline")
        reopened.wifiOnly = true
        reopened.networkChanged(.cellular)
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(OfflineUploadProtocol.fixture.uploadIDs, [])
        reopened.networkChanged(.wifi)
        try await eventually { reopened.uploadError != nil }
        XCTAssertEqual(OfflineUploadProtocol.fixture.uploadIDs, [item.id])
        XCTAssertEqual(try Data(contentsOf: store.audioURL(item.id)), bytes, "Lost connectivity must never delete or rewrite saved audio")
        XCTAssertEqual(try store.recordings(), [item])

        OfflineUploadProtocol.fixture.acceptUploads()
        reopened.networkChanged(.offline)
        reopened.networkChanged(.wifi)
        try await eventually { reopened.pending.isEmpty }
        XCTAssertEqual(OfflineUploadProtocol.fixture.uploadIDs, [item.id, item.id], "Retry keeps the stable idempotency key")
        XCTAssertTrue(try store.recordings().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.audioURL(item.id).path))
        XCTAssertNil(reopened.uploadError)
        UserDefaults.standard.removeObject(forKey: "instant.listening.wifiOnly.\(scope)")
    }

    private func eventually(_ predicate: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<200 {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Timed out waiting for queued upload", file: file, line: line)
    }
}

private final class OfflineUploadProtocol: URLProtocol, @unchecked Sendable {
    static let fixture = OfflineUploadFixture()
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "offline.listening.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let upload = request.httpMethod == "POST"
        let payload = listeningTestRequestBody(request)
        let itemID = (payload["items"] as? [[String:Any]])?.first?["segmentId"] as? String ?? "missing"
        if upload && !Self.fixture.upload(itemID) {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)); return
        }
        let body: [String: Any] = upload
            ? ["batchId":payload["batchId"]!,"streamId":payload["streamId"]!,"sequence":payload["sequence"]!,"status":"accepted"]
            : ["segments": []]
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: upload ? 202 : 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
private final class OfflineUploadFixture: @unchecked Sendable {
    private let lock = NSLock()
    private var ids: [String] = []
    private var accept = false
    var uploadIDs: [String] { lock.withLock { ids } }
    func reset() { lock.withLock { ids = []; accept = false } }
    func acceptUploads() { lock.withLock { accept = true } }
    func upload(_ id: String) -> Bool { lock.withLock { ids.append(id); return accept } }
}
