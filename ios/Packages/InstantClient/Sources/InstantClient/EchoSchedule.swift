import Foundation

public struct EchoSchedule: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var weekdays: [Int]
    public var reminderTime: String
    public var stopTime: String
    public var autoStop: Bool
    public var timeZone: String
    public var revision: String?
    public init(enabled: Bool = false, weekdays: [Int] = [1, 2, 3, 4, 5], reminderTime: String = "09:00", stopTime: String = "18:00", autoStop: Bool = true, timeZone: String = "UTC", revision: String? = nil) {
        self.enabled = enabled; self.weekdays = weekdays; self.reminderTime = reminderTime; self.stopTime = stopTime
        self.autoStop = autoStop; self.timeZone = timeZone; self.revision = revision
    }
    public var isValid: Bool {
        let pattern = #"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$"#
        return !weekdays.isEmpty && Set(weekdays).count == weekdays.count && weekdays.allSatisfy { (1...7).contains($0) }
            && reminderTime.range(of: pattern, options: .regularExpression) != nil
            && stopTime.range(of: pattern, options: .regularExpression) != nil && (!autoStop || stopTime > reminderTime)
            && TimeZone(identifier: timeZone) != nil && (revision == nil || UUID(uuidString: revision!) != nil)
    }
    /// Absolute wall-clock deadline. Never recompute from a pause-adjusted elapsed-time clock.
    public func nextStop(after anchor: Date) -> Date? {
        guard enabled, autoStop, isValid, let zone = TimeZone(identifier: timeZone) else { return nil }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
        var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(secondsFromGMT: 0)!
        let time = stopTime.split(separator: ":").compactMap { Int($0) }
        for offset in 0...8 {
            guard let day = calendar.date(byAdding: .day, value: offset, to: calendar.startOfDay(for: anchor)),
                  weekdays.contains((calendar.component(.weekday, from: day) + 5) % 7 + 1) else { continue }
            var components = calendar.dateComponents([.year, .month, .day], from: day)
            components.hour = time[0]; components.minute = time[1]; components.second = 0
            guard let nominal = utc.date(from: components) else { continue }
            let offsets = Set([-36, -12, 0, 12, 36].map { zone.secondsFromGMT(for: nominal.addingTimeInterval(Double($0) * 3600)) })
            func minute(_ value: Date) -> Int { calendar.component(.hour, from: value) * 60 + calendar.component(.minute, from: value) }
            let candidates = offsets.map { nominal.addingTimeInterval(-Double($0)) }.filter {
                calendar.isDate($0, inSameDayAs: day) && minute($0) >= time[0] * 60 + time[1]
            }.sorted { minute($0) == minute($1) ? $0 < $1 : minute($0) < minute($1) }
            if let first = candidates.first, first > anchor { return first }
        }
        return nil
    }
}

public extension InstantClient {
    func echoSchedule() async throws -> EchoSchedule {
        let value: EchoSchedule = try await send("GET", ["echo", "schedule"])
        guard value.isValid else { throw InstantClientError.invalidResponse }; return value
    }
    func saveEchoSchedule(_ value: EchoSchedule) async throws -> EchoSchedule {
        guard value.isValid else { throw InstantClientError.invalidResponse }
        let saved: EchoSchedule = try await send("PUT", ["echo", "schedule"], body: .object([
            "enabled": .bool(value.enabled), "weekdays": .array(value.weekdays.sorted().map { .number(Double($0)) }),
            "reminderTime": .string(value.reminderTime), "stopTime": .string(value.stopTime), "autoStop": .bool(value.autoStop),
            "timeZone": .string(value.timeZone), "revision": value.revision.map(JSONValue.string) ?? .null,
        ]))
        guard saved.isValid else { throw InstantClientError.invalidResponse }; return saved
    }
}
