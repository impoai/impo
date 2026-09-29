import SwiftUI
import InstantClient

/// Display order and names for Mem0's default categories. The server may add categories;
/// unknown ones still load under their raw name at the end.
struct MemoryCategoryInfo: Identifiable, Hashable {
    let id: String
    let title: String
    let symbol: String

    static let health = MemoryCategoryInfo(id: "health", title: "Health", symbol: "heart.fill")
    static let personal = MemoryCategoryInfo(id: "personal_details", title: "About you", symbol: "person.fill")
    static let preferences = MemoryCategoryInfo(id: "user_preferences", title: "Preferences", symbol: "star.fill")
    /// Every category except Health, which has its own large card.
    static let folders: [MemoryCategoryInfo] = [
        personal, preferences,
        .init(id: "family", title: "Family", symbol: "figure.2.and.child.holdinghands"),
        .init(id: "professional_details", title: "Work", symbol: "briefcase.fill"),
        .init(id: "hobbies", title: "Hobbies", symbol: "paintpalette.fill"),
        .init(id: "travel", title: "Travel", symbol: "airplane"),
        .init(id: "food", title: "Food", symbol: "fork.knife"),
        .init(id: "sports", title: "Sports", symbol: "figure.run"),
        .init(id: "music", title: "Music", symbol: "music.note"),
        .init(id: "entertainment", title: "Entertainment", symbol: "film.fill"),
        .init(id: "technology", title: "Technology", symbol: "desktopcomputer"),
        .init(id: "fashion", title: "Fashion", symbol: "tshirt.fill"),
        .init(id: "milestones", title: "Milestones", symbol: "flag.fill"),
        .init(id: "misc", title: "Other", symbol: "square.grid.2x2.fill"),
    ]
    static func named(_ id: String) -> MemoryCategoryInfo {
        ([health] + folders).first { $0.id == id } ?? .init(id: id, title: id.replacingOccurrences(of: "_", with: " ").capitalized, symbol: "folder.fill")
    }
}

/// Long-term memories written by the server's hourly consolidation. The app only reads them
/// and lets the user forget one; there is no local copy.
@MainActor @Observable
final class MemoriesModel {
    var summary: MemorySummary?
    /// Loaded pages per category, newest first.
    var pages: [String: [Memory]] = [:]
    var cursors: [String: String] = [:]
    var loading: Set<String> = []
    var error: String?
    var isLive: Bool { client != nil }
    @ObservationIgnored private var client: InstantClient?
    @ObservationIgnored private var scope: String?
    @ObservationIgnored private var revision = UUID()

    func configure(scope: String?, client: InstantClient?) {
        guard scope != self.scope else { self.client = client; return }
        self.scope = scope; self.client = client; revision = UUID()
        summary = nil; pages = [:]; cursors = [:]; loading = []; error = nil
    }

    func count(_ category: String) -> Int { summary?.categories[category] ?? 0 }
    func hasMore(_ category: String) -> Bool { cursors[category] != nil }

    /// Summary plus the first memories of the categories shown on the overview.
    func refresh() async {
        guard let client, !Task.isCancelled else { return }
        let token = revision
        do {
            let value = try await client.memorySummary()
            guard token == revision else { return }
            summary = value; error = nil
            for category in [MemoryCategoryInfo.health, .personal, .preferences].map(\.id) where count(category) > 0 {
                await load(category)
            }
            ListeningDiagnostics.shared.record("memories.loaded", ["total": String(value.total)])
        } catch {
            guard token == revision, !isCancellation(error) else { return }
            self.error = "Couldn't load your memories. Pull down to try again."
            ListeningDiagnostics.shared.record("memories.load_failed", ["status": String((error as? InstantAPIError)?.statusCode ?? 0)])
        }
    }

    func load(_ category: String, more: Bool = false) async {
        guard let client, !loading.contains(category), !more || hasMore(category) else { return }
        let token = revision
        loading.insert(category)
        defer { if token == revision { loading.remove(category) } }
        do {
            let page = try await client.memories(category: category, cursor: more ? cursors[category] : nil)
            guard token == revision else { return }
            if more {
                let known = Set((pages[category] ?? []).map(\.id))
                pages[category, default: []] += page.memories.filter { !known.contains($0.id) }
            } else { pages[category] = page.memories }
            cursors[category] = page.nextCursor
            error = nil
        } catch {
            guard token == revision, !isCancellation(error) else { return }
            self.error = "Couldn't load these memories. Try again when you're connected."
        }
    }

    /// Forget one memory everywhere it is shown, then refresh counts.
    func forget(_ memory: Memory) async {
        guard let client else { return }
        let token = revision
        do {
            try await client.deleteMemory(memory.id)
            guard token == revision else { return }
            for key in pages.keys { pages[key]?.removeAll { $0.id == memory.id } }
            if let value = try? await client.memorySummary(), token == revision { summary = value }
        } catch {
            guard token == revision, !isCancellation(error) else { return }
            self.error = "Couldn't remove this memory. Try again."
        }
    }

    private func isCancellation(_ error: Error) -> Bool {
        let ns = error as NSError
        return Task.isCancelled || error is CancellationError || (ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled)
    }
}
