import Foundation
import CryptoKit
import InstantClient

/// Metadata is saved before capture starts, then finalized before any upload.
/// A restarted app keeps the same segment ID and timestamps when retrying.
struct PendingRecording: Codable, Identifiable, Equatable {
    var id: String
    var startedAt: Date
    var endedAt: Date
    var hasSpeech: Bool
    var ready: Bool
    // Missing on pre-VAD recordings: preserve their original retry contract.
    var requiresVAD: Bool? = nil
    var speechAnalysis: ListeningSpeechAnalysis? = nil
    var overlapSeconds: Double? = nil
    var streaming: Bool? = nil
    var listeningSessionId: String? = nil
    var locations: [EchoLocationSpan]? = nil
}

struct ListeningStore {
    let directory: URL
    var sessionId: String? = nil
    var locationHistory: EchoLocationHistory? = nil

    init(scope: String, root: URL? = nil) throws {
        let base = try root ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let hash = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
        directory = base.appendingPathComponent("Listening/\(hash)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var folder = directory
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try folder.setResourceValues(values)
    }

    init(existingDirectory: URL) { directory = existingDirectory }

    func audioURL(_ id: String) -> URL { directory.appendingPathComponent(id).appendingPathExtension("m4a") }
    func rawURL(_ id: String) -> URL { directory.appendingPathComponent(id).appendingPathExtension("caf") }
    func encodingURL(_ id: String) -> URL { directory.appendingPathComponent(id + ".encoding").appendingPathExtension("m4a") }
    private func metadataURL(_ id: String) -> URL { directory.appendingPathComponent(id).appendingPathExtension("json") }

    func save(_ recording: PendingRecording) throws {
        try JSONEncoder().encode(recording).write(to: metadataURL(recording.id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func recordings() throws -> [PendingRecording] {
        try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .compactMap { url in
                do { return try JSONDecoder().decode(PendingRecording.self, from: Data(contentsOf: url)) }
                catch where Self.isMissing(error) { return nil } // concurrent upload receipt removed it
            }
            .sorted { $0.startedAt < $1.startedAt }
    }

    func storageBytes() throws -> Int {
        let files = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.fileSizeKey], options: [.skipsHiddenFiles])?.allObjects as? [URL] ?? []
        return try files
            .reduce(0) { total, url in
                do { return total + ((try url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
                catch where Self.isMissing(error) { return total }
            }
    }

    private static func isMissing(_ error: Error) -> Bool {
        let error = error as NSError
        return error.domain == NSCocoaErrorDomain && [NSFileReadNoSuchFileError, NSFileNoSuchFileError].contains(error.code)
    }

    func remove(_ id: String) throws {
        // Remove audio first: a crash may leave metadata to clean up, but never orphan audio.
        for url in [audioURL(id), rawURL(id), encodingURL(id), metadataURL(id)] where FileManager.default.fileExists(atPath: url.path) {
            do { try FileManager.default.removeItem(at: url) }
            catch where Self.isMissing(error) { }
        }
    }
}
