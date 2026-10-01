import Foundation
import XCTest
import InstantClient
@testable import Instant

@MainActor final class AccountDeletionTests: XCTestCase {
    func testDeletionRemovesOnlyTheSelectedAccountsOfflineAudio() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let alice = try ListeningStore(scope: "account-deletion|alice", root: root)
        let bob = try ListeningStore(scope: "account-deletion|bob", root: root)
        for store in [alice, bob] {
            let item = PendingRecording(id: UUID().uuidString, startedAt: Date(timeIntervalSince1970: 10), endedAt: Date(timeIntervalSince1970: 12), hasSpeech: true, ready: true)
            try store.save(item); try Data([1, 2, 3]).write(to: store.audioURL(item.id))
        }
        let model = ListeningModel(storageRoot: root, observeAudio: false)
        try await model.deleteLocalAccountData(scope: "account-deletion|alice")
        XCTAssertFalse(FileManager.default.fileExists(atPath: alice.directory.path))
        XCTAssertEqual(try bob.recordings().count, 1)
        // An interrupted deletion can safely repeat after a restart.
        try await model.deleteLocalAccountData(scope: "account-deletion|alice")
        XCTAssertFalse(FileManager.default.fileExists(atPath: alice.directory.path))
        XCTAssertEqual(try bob.recordings().count, 1)
    }
}
