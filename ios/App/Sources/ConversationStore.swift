import CryptoKit
import Foundation
import InstantClient

/// Finished messages of one account's main conversation, kept on this iPhone so
/// the chat opens from disk and only new messages are fetched.
///
/// Each message is one file named by its zero-padded sequence, holding the JSON
/// the server sent, so a directory listing is the sequence order and a message
/// is never rewritten. Only terminal messages are stored: a reply that is still
/// streaming is re-read from the server. The store is keyed by server and
/// account; clearing an account's state removes its directory.
struct ConversationStore {
    static let terminalStatuses: Set<String> = ["completed", "failed", "cancelled"]
    /// Below this many pages the chat scrolls fine; older ones load on demand.
    static let pageSize = 50

    let directory: URL
    private let decoder = JSONDecoder()

    init(scope: String) {
        directory = Self.base.appendingPathComponent(Self.name(for: scope), isDirectory: true)
        try? FileManager.default.createDirectory(at: directory.appendingPathComponent("messages", isDirectory: true), withIntermediateDirectories: true)
    }

    /// Scopes carry a URL and an account subject; the directory name must not.
    private static func name(for scope: String) -> String {
        SHA256.hash(data: Data(scope.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    private static var base: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Conversations", isDirectory: true)
    }

    /// Every account's stored conversation; used when the signed-in account changes.
    static func removeAll() { try? FileManager.default.removeItem(at: base) }

    /// Drops this conversation's messages; the next read starts from the server again.
    func reset() {
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory.appendingPathComponent("messages", isDirectory: true), withIntermediateDirectories: true)
    }

    /// The server conversation these messages belong to.
    var conversationId: String? {
        get { try? String(contentsOf: directory.appendingPathComponent("conversation"), encoding: .utf8) }
        nonmutating set { try? newValue?.write(to: directory.appendingPathComponent("conversation"), atomically: true, encoding: .utf8) }
    }

    // MARK: Reading

    /// Every stored sequence, ascending.
    private var sequences: [Int] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.appendingPathComponent("messages").path)) ?? []
        return names.compactMap { $0.hasSuffix(".json") ? Int($0.dropLast(5)) : nil }.sorted()
    }

    var newestSequence: Int? { sequences.last }

    /// The newest `limit` messages, oldest first.
    func latest(_ limit: Int = pageSize) -> [ConversationMessage] {
        read(sequences.suffix(limit))
    }

    /// Up to `limit` messages below `sequence`, oldest first.
    func before(_ sequence: Int, limit: Int = pageSize) -> [ConversationMessage] {
        read(sequences.filter { $0 < sequence }.suffix(limit))
    }

    private func read<S: Sequence>(_ selected: S) -> [ConversationMessage] where S.Element == Int {
        selected.compactMap { sequence in
            guard let data = try? Data(contentsOf: file(sequence)) else { return nil }
            return try? decoder.decode(ConversationMessage.self, from: data)
        }
    }

    private func file(_ sequence: Int) -> URL {
        directory.appendingPathComponent("messages", isDirectory: true).appendingPathComponent(String(format: "%012d.json", sequence))
    }

    /// Whether the oldest message of the conversation has been stored, so there
    /// is nothing older to fetch.
    var reachedStart: Bool {
        get { FileManager.default.fileExists(atPath: directory.appendingPathComponent("start").path) }
        nonmutating set {
            let marker = directory.appendingPathComponent("start")
            if newValue { FileManager.default.createFile(atPath: marker.path, contents: Data()) } else { try? FileManager.default.removeItem(at: marker) }
        }
    }

    // MARK: Writing

    /// Stores the finished messages of a page. A finished assistant message with
    /// no content was not hydrated and may fill in later, so it is not stored.
    func store(_ page: ConversationPage) {
        for (message, raw) in zip(page.messages, page.rawMessages) where Self.isStorable(message) {
            let destination = file(message.sequence)
            guard !FileManager.default.fileExists(atPath: destination.path) else { continue }
            try? raw.write(to: destination, options: .atomic)
        }
    }

    static func isStorable(_ message: ConversationMessage) -> Bool {
        guard terminalStatuses.contains(message.status) else { return false }
        return message.role == "user" || !message.text.isEmpty || !message.files.isEmpty || !message.actions.isEmpty || !message.products.isEmpty
    }
}
