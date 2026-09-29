import Foundation
import InstantClient

struct ListeningBatchPayload: Codable {
    struct Item: Codable {
        let segmentId: String
        let startedAt: String
        let endedAt: String
        let mimeType: String
        let audio: String
        var locations: [EchoLocationSpan]? = nil
    }
    let batchId: String
    let streamId: String
    let sequence: Int
    let sessionId: String
    let items: [Item]
}
struct StoredListeningBatch: Codable, Identifiable {
    var id: String { batchId }
    let batchId: String
    let streamId: String
    let sequence: Int
    let sessionId: String
    let segmentIDs: [String]
    let audioBytes: Int
    let audioSeconds: Double
    let startedAt: Date
}

/// Payload bytes never change after sealing, including across app restarts.
/// A shared lock serializes sealing with background URLSession receipt cleanup.
struct ListeningBatchStore {
    private static let lock = NSRecursiveLock()
    let store: ListeningStore
    var directory: URL { store.directory.appendingPathComponent("Batches", isDirectory: true) }
    private struct State: Codable { var streamId: String; var nextSequence: Int }
    func payloadURL(_ id: String) -> URL { directory.appendingPathComponent(id + ".json") }
    private func metadataURL(_ id: String) -> URL { directory.appendingPathComponent(id + ".meta") }
    private func write<T: Encodable>(_ value: T, to url: URL) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(value).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    private func prepare() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    }
    private func descriptor(_ payload: ListeningBatchPayload) throws -> StoredListeningBatch {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let first = payload.items.first, let start = formatter.date(from: first.startedAt) else { throw InstantClientError.invalidResponse }
        let seconds = payload.items.reduce(0.0) { total, item in total + (formatter.date(from: item.endedAt)?.timeIntervalSince(formatter.date(from: item.startedAt) ?? start) ?? 0) }
        return StoredListeningBatch(batchId: payload.batchId, streamId: payload.streamId, sequence: payload.sequence, sessionId: payload.sessionId,
            segmentIDs: payload.items.map(\.segmentId), audioBytes: payload.items.reduce(0) { $0 + (Data(base64Encoded: $1.audio)?.count ?? 0) }, audioSeconds: seconds, startedAt: start)
    }
    func batches() throws -> [StoredListeningBatch] {
        try Self.lock.withLock {
            try prepare()
            return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "json" && $0.lastPathComponent != "state.json" }.map { url in
                    let id = url.deletingPathExtension().lastPathComponent
                    if FileManager.default.fileExists(atPath: metadataURL(id).path) {
                        return try JSONDecoder().decode(StoredListeningBatch.self, from: Data(contentsOf: metadataURL(id)))
                    }
                    let item = try descriptor(JSONDecoder().decode(ListeningBatchPayload.self, from: Data(contentsOf: url)))
                    try write(item, to: metadataURL(id))
                    return item
                }.sorted { $0.sequence < $1.sequence }
        }
    }
    @discardableResult func seal(force: Bool, now: Date = Date()) throws -> [StoredListeningBatch] {
        try Self.lock.withLock {
            let existing = try batches()
            let stateURL = directory.appendingPathComponent("state.json")
            var state: State
            if FileManager.default.fileExists(atPath: stateURL.path) { state = try JSONDecoder().decode(State.self, from: Data(contentsOf: stateURL)) }
            else { state = State(streamId: existing.first?.streamId ?? UUID().uuidString.lowercased(), nextSequence: 1) }
            // Payload first, counter second: repair a crash between those writes.
            state.nextSequence = max(state.nextSequence, (existing.map(\.sequence).max() ?? 0) + 1)
            try write(state, to: stateURL)
            let assigned = Set(existing.flatMap(\.segmentIDs))
            let available = try store.recordings().filter { $0.ready && !assigned.contains($0.id) }
            var position = 0
            var sealed: [StoredListeningBatch] = []
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            while position < available.count {
                var items: [ListeningBatchPayload.Item] = []; var bytes = 0; var seconds = 0.0
                let first = available[position]
                let session = first.listeningSessionId ?? state.streamId
                var boundary = false
                while position < available.count {
                    let item = available[position]
                    let duration = item.endedAt.timeIntervalSince(item.startedAt)
                    if !items.isEmpty && ((item.listeningSessionId ?? state.streamId) != session || items.count >= 16 || seconds + duration > 301) { boundary = true; break }
                    guard item.requiresVAD != true || item.speechAnalysis != nil else { break }
                    let audio = try Data(contentsOf: store.audioURL(item.id))
                    guard audio.count <= 1_048_576, duration <= 301 else { throw ListeningBatchError.recordingTooLarge }
                    if !items.isEmpty && bytes + audio.count > 1_048_576 { boundary = true; break }
                    bytes += audio.count; seconds += duration
                    items.append(.init(segmentId: item.id, startedAt: formatter.string(from: item.startedAt), endedAt: formatter.string(from: item.endedAt), mimeType: "audio/mp4", audio: audio.base64EncodedString(), locations: item.locations))
                    position += 1
                }
                guard !items.isEmpty, force || boundary || seconds >= 120 || now.timeIntervalSince(first.endedAt) >= 300 else { break }
                let payload = ListeningBatchPayload(batchId: UUID().uuidString.lowercased(), streamId: state.streamId, sequence: state.nextSequence, sessionId: session, items: items)
                try write(payload, to: payloadURL(payload.batchId))
                state.nextSequence += 1
                try write(state, to: stateURL)
                let metadata = try descriptor(payload)
                try write(metadata, to: metadataURL(payload.batchId)); sealed.append(metadata)
                ListeningDiagnostics.shared.record("batch.sealed", ["batchId":metadata.batchId,"sequence":"\(metadata.sequence)","streamId":metadata.streamId,"segments":"\(items.count)","bytes":"\(bytes)","seconds":"\(Int(seconds))"])
            }
            return sealed
        }
    }
    func removeConfirmed(_ batch: StoredListeningBatch) throws {
        try Self.lock.withLock {
            for id in batch.segmentIDs { try store.remove(id) }
            // Counter was durable before this payload became uploadable.
            for url in [payloadURL(batch.batchId), metadataURL(batch.batchId)] where FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        }
    }
    func verify(_ receipt: ListeningBatchReceipt, for batch: StoredListeningBatch) throws {
        guard receipt.batchId == batch.batchId, receipt.streamId == batch.streamId, receipt.sequence == batch.sequence, receipt.status == "accepted" else { throw InstantClientError.invalidResponse }
    }
}
enum ListeningBatchError: Error { case recordingTooLarge }
