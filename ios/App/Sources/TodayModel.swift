import SwiftUI
import InstantClient

@MainActor @Observable
final class TodayModel {
    var briefs: [TodayBrief] = []
    var settings: TodaySettings?
    var error: String?
    var isLoading = false
    var hasMore = false
    var isLive: Bool { client != nil }
    private var cursor: String?
    @ObservationIgnored private var client: InstantClient?
    @ObservationIgnored private var scope: String?
    @ObservationIgnored private var revision = UUID()
    var contextID: UUID { revision }

    func configure(scope: String?, client: InstantClient?) {
        guard scope != self.scope else { self.client = client; return }
        self.scope = scope; self.client = client; revision = UUID()
        briefs = []; settings = nil; error = nil; cursor = nil; hasMore = false; isLoading = false
    }
    func syncContext(displayName: String) async {
        guard let client, !Task.isCancelled else { return }
        let token = revision
        do {
            let response = try await client.configureToday(timeZone: TimeZone.current.identifier, locale: Locale.preferredLanguages.first ?? Locale.current.identifier, displayName: displayName)
            guard token == revision else { return }
            settings = response.settings
            ListeningDiagnostics.shared.record("today.context_synced")
        } catch {
            guard token == revision else { return }
            if isCancellation(error) { ListeningDiagnostics.shared.record("today.context_cancelled"); return }
            self.error = "Couldn't sync your brief preferences. Try again when you're connected."
            recordFailure("today.context_failed", error)
        }
    }
    func loadNotificationBrief(_ id: String) async {
        guard let client else { return }
        let captured = revision
        do {
            let brief = try await client.todayBrief(id)
            guard captured == revision else { return }
            if !briefs.contains(where: { $0.id == id }) { briefs.insert(brief, at: 0) }
        } catch { if captured == revision { self.error = "This Brief is unavailable. It may have been removed." } }
    }
    func refresh(more: Bool = false, preserveHistory: Bool = false) async {
        guard let client, !Task.isCancelled, !isLoading, !more || hasMore else { return }
        let token = revision; isLoading = true
        defer { if token == revision { isLoading = false } }
        do {
            let page = try await client.todayBriefs(cursor: more ? cursor : nil)
            guard token == revision else { return }
            if more {
                let known = Set(briefs.map(\.id)); briefs += page.briefs.filter { !known.contains($0.id) }
            } else if preserveHistory, page.nextCursor != nil, let last = page.briefs.last, briefs.count > page.briefs.count {
                let known = Set(page.briefs.map(\.id))
                briefs = page.briefs + briefs.filter { !known.contains($0.id) && ($0.scheduledAt < last.scheduledAt || ($0.scheduledAt == last.scheduledAt && $0.id < last.id)) }
                error = nil; return
            } else { briefs = page.briefs }
            cursor = page.nextCursor; hasMore = cursor != nil; error = nil
            ListeningDiagnostics.shared.record("today.loaded", ["briefs": String(page.briefs.count), "phase": more ? "older" : "latest"])
        } catch {
            guard token == revision else { return }
            // SwiftUI cancels view tasks when changing tabs or leaving the foreground.
            // URLSession reports this as -999; it is not a failed server request.
            if isCancellation(error) { ListeningDiagnostics.shared.record("today.load_cancelled"); return }
            self.error = "Couldn't load your briefs. Pull down to try again."
            recordFailure("today.load_failed", error)
        }
    }
    private func isCancellation(_ error: Error) -> Bool {
        let ns = error as NSError
        return Task.isCancelled || error is CancellationError || (ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled)
    }
    private func recordFailure(_ event: String, _ error: Error) {
        if let api = error as? InstantAPIError {
            ListeningDiagnostics.shared.record(event, ["code": api.code, "status": String(api.statusCode), "requestId": api.requestId ?? ""])
        } else { ListeningDiagnostics.shared.error(event, error) }
    }
    func save(slots: [TodaySlot]? = nil, location: TodayLocation? = nil, clearLocation: Bool = false, contentPreferences: TodayContentPreferences? = nil) async throws {
        guard let client else { throw TodayError.offline }
        let token = revision
        let response = try await client.configureToday(timeZone: TimeZone.current.identifier, locale: Locale.preferredLanguages.first ?? Locale.current.identifier,
            displayName: settings?.displayName ?? "", slots: slots, location: location, clearLocation: clearLocation, contentPreferences: contentPreferences)
        guard token == revision else { throw CancellationError() }
        settings = response.settings
    }
    func action(brief: TodayBrief, card: TodayCard) async throws -> TodayAction {
        guard let client, let id = card.id else { throw TodayError.offline }
        let token = revision
        let response = try await client.todayCardAction(briefID: brief.id, cardID: id)
        guard token == revision else { throw CancellationError() }
        return response.action
    }
    func feedback(brief: TodayBrief, card: TodayCard, action: String) async throws {
        guard let client, let id = card.id else { throw TodayError.offline }
        let token = revision
        try await client.todayCardFeedback(briefID: brief.id, cardID: id, action: action)
        guard token == revision else { throw CancellationError() }
        let updated = try await client.todayBrief(brief.id)
        guard token == revision else { throw CancellationError() }
        if let index = briefs.firstIndex(where: { $0.id == brief.id }) { briefs[index] = updated }
    }
    func resetSuggestions() async throws {
        guard let client else { throw TodayError.offline }
        let token = revision; try await client.resetTodayTopics()
        guard token == revision else { throw CancellationError() }
        await refresh()
    }
    func source(for brief: TodayBrief, source: TodaySource) async throws -> TodaySource {
        guard let client else { throw TodayError.offline }
        let token = revision
        let value = try await client.todaySource(briefID: brief.id, recordID: source.recordId)
        guard token == revision else { throw CancellationError() }
        return value
    }
    func delete(_ brief: TodayBrief) async throws {
        guard let client else { throw TodayError.offline }
        let token = revision
        try await client.deleteTodayBrief(brief.id)
        guard token == revision else { throw CancellationError() }
        briefs.removeAll { $0.id == brief.id }
    }
    /// Fetch the entire selected day, including editions not yet paged into the feed.
    func captureDay(_ date: String) async throws -> [TodayBrief] {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--today-preview") { return briefs.filter { $0.localDate == date && $0.status == "completed" } }
        #endif
        guard let client else { throw TodayError.offline }
        let token = revision
        var editions: [TodayBrief] = []; var next: String?
        repeat {
            let page = try await client.todayBriefs(cursor: next, date: date)
            guard token == revision else { throw CancellationError() }
            editions += page.briefs.filter { $0.status == "completed" && $0.content != nil }; next = page.nextCursor
        } while next != nil
        return editions
    }
}
enum TodayError: LocalizedError {
    case offline, exportFailed, empty
    var errorDescription: String? {
        switch self {
        case .offline: "Connect to your Impo account to use Today."
        case .exportFailed: "Couldn't create the full-page capture. Please try again."
        case .empty: "There aren't any completed briefs for this day yet."
        }
    }
}
