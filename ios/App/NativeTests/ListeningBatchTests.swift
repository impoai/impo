import Foundation
import InstantClient
import XCTest
@testable import Instant

func listeningTestRequestBody(_ request: URLRequest) -> [String:Any] {
    var data = request.httpBody ?? Data()
    if data.isEmpty, let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }; var buffer = [UInt8](repeating:0,count:4096)
        while stream.hasBytesAvailable { let count = stream.read(&buffer,maxLength:buffer.count); if count <= 0 { break }; data.append(contentsOf:buffer.prefix(count)) }
    }
    return (try? JSONSerialization.jsonObject(with:data) as? [String:Any]) ?? [:]
}

final class ListeningBatchTests: XCTestCase {
    func testOfflineBatchesAreImmutableOrderedAndRepairCounterAfterCrash() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:root) }
        let store = try ListeningStore(scope:"batch-test",root:root)
        let origin = Date().addingTimeInterval(-4000)
        for index in 0..<20 {
            let item = PendingRecording(id:UUID().uuidString.lowercased(),startedAt:origin.addingTimeInterval(Double(index)*30),endedAt:origin.addingTimeInterval(Double(index+1)*30),hasSpeech:true,ready:true)
            try store.save(item); try Data(repeating:UInt8(index),count:4000).write(to:store.audioURL(item.id))
        }
        let queue = ListeningBatchStore(store:store)
        XCTAssertEqual(try queue.seal(force:false).count,2)
        let original = try queue.batches(); XCTAssertEqual(original.map(\.sequence),[1,2]); XCTAssertEqual(original.map { $0.segmentIDs.count },[10,10])
        let bytes = try Data(contentsOf:queue.payloadURL(original[0].batchId))
        // Simulate death after payload creation, before state and sidecar write.
        try FileManager.default.removeItem(at:queue.directory.appendingPathComponent("state.json"))
        try FileManager.default.removeItem(at:queue.directory.appendingPathComponent(original[0].batchId+".meta"))
        let recovered = ListeningBatchStore(store:try ListeningStore(scope:"batch-test",root:root))
        XCTAssertTrue(try recovered.seal(force:true).isEmpty)
        XCTAssertEqual(try Data(contentsOf:queue.payloadURL(original[0].batchId)),bytes)
        try recovered.removeConfirmed(original[0]); XCTAssertEqual(try store.recordings().count,10)
        let next = PendingRecording(id:UUID().uuidString.lowercased(),startedAt:Date().addingTimeInterval(-2),endedAt:Date(),hasSpeech:true,ready:true)
        try store.save(next); try Data([1,2,3]).write(to:store.audioURL(next.id))
        XCTAssertEqual(try recovered.seal(force:true).first?.sequence,3)
        XCTAssertEqual(try recovered.batches().map(\.sequence),[2,3])
    }
    func testShortTailWaitsAndIncorrectReceiptCannotDeleteAudio() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString); defer { try? FileManager.default.removeItem(at:root) }
        let store = try ListeningStore(scope:"tail",root:root);let now = Date()
        let item = PendingRecording(id:UUID().uuidString.lowercased(),startedAt:now.addingTimeInterval(-20),endedAt:now,hasSpeech:true,ready:true)
        try store.save(item);try Data([1,2,3]).write(to:store.audioURL(item.id))
        let queue = ListeningBatchStore(store:store)
        XCTAssertTrue(try queue.seal(force:false,now:now.addingTimeInterval(29)).isEmpty)
        let batch = try XCTUnwrap(queue.seal(force:false,now:now.addingTimeInterval(31)).first)
        let wrong = try JSONDecoder().decode(ListeningBatchReceipt.self,from:Data("{\"batchId\":\"wrong\",\"streamId\":\"wrong\",\"sequence\":1,\"status\":\"accepted\"}".utf8))
        XCTAssertThrowsError(try queue.verify(wrong,for:batch));XCTAssertEqual(try store.recordings(),[item])
        XCTAssertGreaterThan(try store.storageBytes(),try Data(contentsOf:queue.payloadURL(batch.batchId)).count)
    }
    func testLogsSurviveReopenRedactUnapprovedFieldsAndExport() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString);defer { try? FileManager.default.removeItem(at:root) }
        let logger = ListeningDiagnostics(root:root,maxBytes:8192)
        logger.record("upload.receipt",["batchId":"test-batch","status":"202","authorization":"SECRET_TOKEN","audio":"PRIVATE_AUDIO","transcript":"PRIVATE_TRANSCRIPT"])
        let first = try await logger.read(); XCTAssertTrue(first.contains("test-batch"));XCTAssertFalse(first.contains("SECRET"));XCTAssertFalse(first.contains("PRIVATE"))
        let reopened = ListeningDiagnostics(root:root,maxBytes:8192)
        let second = try await reopened.read();XCTAssertTrue(second.contains("upload.receipt"))
        for index in 0..<200 { reopened.record("health.heartbeat",["pending":String(index)]) }
        _ = try await reopened.read()
        let files = try FileManager.default.contentsOfDirectory(at:root,includingPropertiesForKeys:[.fileSizeKey])
        let total = try files.reduce(0) { $0 + (try $1.resourceValues(forKeys:[.fileSizeKey]).fileSize ?? 0) };XCTAssertLessThanOrEqual(total,8192)
        let exported = try await reopened.export();let content = try String(contentsOf:exported,encoding:.utf8)
        XCTAssertTrue(content.contains("199"));XCTAssertFalse(content.contains("SECRET"))
    }
}
