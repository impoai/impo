import Foundation
import InstantClient

/// A bounded, lock-protected bridge from main-actor location callbacks to the capture queue.
/// Only resolved place names are kept; coordinates never enter the recording store.
final class EchoLocationHistory: @unchecked Sendable {
    struct Fix: Equatable, Sendable {
        let capturedAt: Date
        let accuracyMeters: Double
        let city: String
        let country: String
        let district: String?
    }
    private let lock = NSLock()
    private var fixes: [Fix] = []
    private var boundaries: [Date] = []
    static let freshness: TimeInterval = 120

    func pause(at date: Date = Date()) {
        lock.withLock {
            boundaries.append(date)
            boundaries.removeAll { date.timeIntervalSince($0) > 1200 }
            if boundaries.count > 256 { boundaries.removeFirst(boundaries.count - 256) }
        }
    }

    func add(_ fix: Fix, now: Date = Date()) {
        guard fix.accuracyMeters.isFinite, (0...5000).contains(fix.accuracyMeters),
              fix.capturedAt <= now, now.timeIntervalSince(fix.capturedAt) <= Self.freshness,
              Self.validPlace(fix.city), Self.validPlace(fix.country),
              fix.district.map(Self.validPlace) ?? true else { return }
        let fix = Fix(capturedAt: fix.capturedAt, accuracyMeters: fix.accuracyMeters, city: fix.city, country: fix.country, district: fix.accuracyMeters <= 500 ? fix.district : nil)
        lock.withLock {
            guard fixes.last.map({ fix.capturedAt > $0.capturedAt }) ?? true else { return }
            if let last = fixes.last, last.city == fix.city, last.country == fix.country, last.district == fix.district,
               fix.capturedAt.timeIntervalSince(last.capturedAt) < 30,
               !boundaries.contains(where: { $0 >= last.capturedAt && $0 <= fix.capturedAt }) { return }
            fixes.append(fix)
            fixes.removeAll { now.timeIntervalSince($0.capturedAt) > 1200 }
            if fixes.count > 256 { fixes.removeFirst(fixes.count - 256) }
        }
    }

    private static func validPlace(_ value: String) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf16.count <= 100 && value.rangeOfCharacter(from: .controlCharacters) == nil
    }

    func spans(from start: Date, to end: Date) -> [EchoLocationSpan] {
        guard end > start else { return [] }
        let (samples, stops) = lock.withLock { (fixes, boundaries) }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return samples.enumerated().compactMap { index, fix in
            let from = max(start, fix.capturedAt)
            let next = index + 1 < samples.count ? samples[index + 1].capturedAt : end
            let stop = stops.first { $0 >= fix.capturedAt } ?? end
            let to = min(end, next, stop, fix.capturedAt.addingTimeInterval(Self.freshness))
            guard to > from else { return nil }
            let district = fix.accuracyMeters <= 500 ? fix.district : nil
            return EchoLocationSpan(from: formatter.string(from: from), to: formatter.string(from: to),
                                    capturedAt: formatter.string(from: fix.capturedAt), accuracyMeters: fix.accuracyMeters,
                                    granularity: district == nil ? "city" : "district", city: fix.city, country: fix.country, district: district)
        }.prefix(16).map { $0 }
    }
}
