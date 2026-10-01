import Foundation

/// Persistent, bounded event log. Only explicitly allowed metadata fields can be
/// written: no audio, transcript text, tokens, account IDs, or request bodies.
final class ListeningDiagnostics: @unchecked Sendable {
    static let shared = ListeningDiagnostics()
    private let queue = DispatchQueue(label: "ai.impo.listening.diagnostics", qos: .utility)
    private let root: URL
    private let launchUptime = ProcessInfo.processInfo.systemUptime
    private let launch = UUID().uuidString.lowercased()
    private let maxBytes: Int
    private let retention: TimeInterval
    private let allowed: Set<String> = ["clientMessageId","submissionId","messageId","batchId","streamId","sessionId","segmentId","sequence","segments","bytes","seconds","status","code","domain","requestId","network","wifiOnly","recording","speaking","receivingAudio","pending","batches","oldestSeconds","battery","charging","reason","attempt","resuming","shouldResume","route","ms","version","build","phase","briefs","format"]
    init(root: URL? = nil, maxBytes: Int = 20 * 1_024 * 1_024, retention: TimeInterval = 7 * 86400) {
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("ListeningDiagnostics", isDirectory: true)
        self.maxBytes = maxBytes; self.retention = retention
        record("app.launch", ["version":Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?", "build":Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"])
    }
    func record(_ event: String, _ fields: [String: String] = [:]) {
        let now = Date(); let elapsed = ProcessInfo.processInfo.systemUptime - launchUptime
        queue.async { [self] in
            do {
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.protectionKey:FileProtectionType.completeUntilFirstUserAuthentication])
                var directory = root; var values = URLResourceValues(); values.isExcludedFromBackup = true; try directory.setResourceValues(values)
                let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                let time = formatter.string(from: now)
                let safe = fields.filter { allowed.contains($0.key) }.mapValues { String($0.prefix(200)) }
                let row: [String:Any] = ["at":time,"elapsedSinceLaunch":elapsed,"launch":launch,"event":String(event.prefix(80)),"fields":safe]
                var data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]); data.append(10)
                let files = try logFiles()
                let day = String(time.prefix(10))
                let last = files.last
                let sameDay = last?.lastPathComponent.hasPrefix(day) == true
                let room = ((try? last?.resourceValues(forKeys:[.fileSizeKey]).fileSize) ?? 0) < min(maxBytes / 2, 1_048_576)
                let url = sameDay && room ? last! : root.appendingPathComponent("\(day)-\(Int(now.timeIntervalSince1970 * 1000)).jsonl")
                if !FileManager.default.fileExists(atPath: url.path) { try Data().write(to:url, options:[.completeFileProtectionUntilFirstUserAuthentication]) }
                let handle = try FileHandle(forWritingTo:url); defer { try? handle.close() }
                try handle.seekToEnd(); try handle.write(contentsOf:data)
                try prune(now:now)
            } catch { /* Diagnostics must never stop microphone capture. Debug export reports unreadable storage. */ }
        }
    }
    func error(_ event: String, _ error: Error, _ fields: [String:String] = [:]) {
        var fields = fields; let ns = error as NSError
        fields["domain"] = ns.domain; fields["code"] = String(ns.code)
        record(event,fields)
    }
    private func logFiles() throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at:root, includingPropertiesForKeys:[.fileSizeKey,.contentModificationDateKey]).filter { $0.pathExtension == "jsonl" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }
    private func prune(now: Date) throws {
        var total = 0
        for url in try logFiles().reversed() {
            let value = try url.resourceValues(forKeys:[.fileSizeKey,.contentModificationDateKey]); total += value.fileSize ?? 0
            if total > maxBytes || now.timeIntervalSince(value.contentModificationDate ?? .distantPast) > retention { try FileManager.default.removeItem(at:url) }
        }
    }
    func read(limit: Int = 500) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in queue.async { [self] in
            do {
                var lines: [Substring] = []
                for url in try logFiles().reversed() { lines = try String(contentsOf:url,encoding:.utf8).split(separator:"\n") + lines; if lines.count >= limit { break } }
                continuation.resume(returning:lines.suffix(limit).joined(separator:"\n"))
            } catch { continuation.resume(throwing:error) }
        } }
    }
    func export() async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in queue.async { [self] in
            do {
                let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ListeningLogExport",isDirectory:true)
                try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
                let url = folder.appendingPathComponent("Impo-listening-logs.jsonl")
                var data = Data(); for file in try logFiles() { data.append(try Data(contentsOf:file)) }
                try data.write(to:url,options:[.atomic,.completeFileProtectionUntilFirstUserAuthentication]);continuation.resume(returning:url)
            } catch { continuation.resume(throwing:error) }
        } }
    }
}
