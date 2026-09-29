import Foundation
import Observation
import InstantClient

/// The inventory owns scroll positions; the bounded cache owns only transcript bodies.
@MainActor @Observable final class EchoTimelineModel {
    private(set) var days: [ListeningTimelineDay] = []
    private(set) var records: [String: ListeningSegment] = [:]
    private(set) var failures: Set<String> = []
    private(set) var loadingIndex = false
    private(set) var loaded = false
    private(set) var indexError: String?
    private(set) var indexVersion = UUID()
    private(set) var contentVersion = UUID()
    var calendar: [ListeningDay] { days.map { .init(date: $0.date, count: $0.ids.count) } }

    @ObservationIgnored private var client: InstantClient?
    @ObservationIgnored private var scope: String?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var ids: [String] = []
    @ObservationIgnored private var positions: [String: Int] = [:]
    @ObservationIgnored private var desired: [String] = []
    @ObservationIgnored private var stale: Set<String> = []
    @ObservationIgnored private var recent: [String] = []
    @ObservationIgnored private var active: Set<String> = []
    @ObservationIgnored private var worker: Task<Void, Never>?
    @ObservationIgnored private var workerID = UUID()

    func configure(scope: String?, client: InstantClient?) {
        self.client = client
        guard self.scope != scope else { return }
        self.scope = scope; generation = UUID(); cancelWorker()
        days = []; ids = []; positions = [:]; records = [:]; failures = []; stale = []; recent = []; desired = []
        loaded = false; loadingIndex = false; indexError = nil
        indexVersion = UUID(); contentVersion = UUID()
    }

    func refresh() async {
        guard let client, !loadingIndex else { return }
        let token = generation
        loadingIndex = true
        defer { if token == generation { loadingIndex = false } }
        do {
            let index = try await client.listeningTimeline(timeZone: TimeZone.current.identifier)
            guard token == generation, !Task.isCancelled else { return }
            if days != index.days { replaceIndex(index.days) }
            loaded = true; indexError = nil; failures = []
            stale.formUnion(desired)
            startWorker()
        } catch {
            if token == generation, !Self.cancelled(error) { indexError = "Couldn't load Echo. Pull down or tap to retry." }
        }
    }

    /// Called for the actual viewport, including rows whose bodies have never been loaded.
    func show(_ visible: [String]) {
        let indexes = visible.compactMap { positions[$0] }
        guard let first = indexes.min(), let last = indexes.max() else { return }
        let nearby = Array(ids[max(0, first - 12)..<min(ids.count, last + 25)])
        let visibleSet = Set(visible)
        desired = visible + nearby.filter { !visibleSet.contains($0) }
        touch(desired)
        // A distant seek takes priority over an obsolete network request.
        if !active.isEmpty, active.isDisjoint(with: desired) { cancelWorker() }
        startWorker()
    }

    func retry() { failures.subtract(desired); startWorker() }

    func poll() {
        stale.formUnion(desired.filter { records[$0].map { ["pending", "transcribing"].contains($0.status) } ?? false })
        startWorker()
    }

    func update(_ segment: ListeningSegment) {
        guard positions[segment.id] != nil else { return }
        records[segment.id] = segment; stale.remove(segment.id)
        touch([segment.id]); trim(); contentVersion = UUID()
    }

    func remove(_ id: String) {
        replaceIndex(days.compactMap { day in
            let remaining = day.ids.filter { $0 != id }
            return remaining.isEmpty ? nil : .init(date: day.date, ids: remaining)
        })
    }

    private func replaceIndex(_ days: [ListeningTimelineDay]) {
        self.days = days
        ids = days.flatMap(\.ids)
        positions = Dictionary(uniqueKeysWithValues: ids.enumerated().map { ($0.element, $0.offset) })
        let owned = Set(ids)
        records = records.filter { owned.contains($0.key) }
        desired = desired.filter { owned.contains($0) }
        failures.formIntersection(owned); stale.formIntersection(owned)
        recent.removeAll { !owned.contains($0) }
        indexVersion = UUID(); contentVersion = UUID()
    }

    private func startWorker() {
        guard worker == nil, client != nil,
              desired.contains(where: { (records[$0] == nil || stale.contains($0)) && !failures.contains($0) }) else { return }
        let token = generation, operation = UUID()
        workerID = operation
        worker = Task { [weak self] in
            // Coalesce scrolling; a distant jump never walks intervening pages.
            do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
            await self?.hydrate(token: token, operation: operation)
        }
    }

    private func hydrate(token: UUID, operation: UUID) async {
        defer { if workerID == operation { worker = nil; active = [] } }
        while token == generation, workerID == operation, !Task.isCancelled, let client {
            let batch = Array(desired.filter { (records[$0] == nil || stale.contains($0)) && !failures.contains($0) }.prefix(30))
            guard !batch.isEmpty else { return }
            active = Set(batch)
            do {
                let result = try await client.listeningRecords(ids: batch)
                guard token == generation, workerID == operation, !Task.isCancelled else { return }
                let returned = Set(result.map(\.id))
                for segment in result where positions[segment.id] != nil { records[segment.id] = segment }
                stale.subtract(batch)
                // A missing owned record was deleted after the inventory was read.
                let missing = Set(batch).subtracting(returned)
                if !missing.isEmpty {
                    replaceIndex(days.compactMap { day in
                        let remaining = day.ids.filter { !missing.contains($0) }
                        return remaining.isEmpty ? nil : .init(date: day.date, ids: remaining)
                    })
                }
                touch(batch); trim(); contentVersion = UUID()
            } catch {
                guard token == generation, workerID == operation, !Task.isCancelled else { return }
                if !Self.cancelled(error) { failures.formUnion(batch); contentVersion = UUID() }
                return
            }
        }
    }

    private func touch(_ ids: [String]) {
        let touched = Set(ids)
        recent.removeAll { touched.contains($0) }
        recent.append(contentsOf: ids)
    }

    private func trim() {
        let keep = Set(desired + recent.filter { records[$0] != nil }.suffix(180 - min(180, desired.count)))
        records = records.filter { keep.contains($0.key) }
        recent = recent.filter { keep.contains($0) }
        failures.formIntersection(Set(desired)); stale.formIntersection(Set(records.keys))
    }

    private func cancelWorker() {
        worker?.cancel(); worker = nil; active = []; workerID = UUID()
    }

    private static func cancelled(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }
}
