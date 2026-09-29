import Foundation
import InstantClient

/// Pure validation shared by the native handlers. The interval is [start, end).
struct DeviceDataInput: Sendable {
    enum Metric: String, CaseIterable, Sendable { case steps, active_energy, heart_rate, sleep }
    enum Invalid: Error, Sendable {
        case arguments, dateRange, timezone, limit, metrics
        var code: String {
            switch self {
            case .arguments: "invalid_arguments"
            case .dateRange: "invalid_date_range"
            case .timezone: "invalid_timezone"
            case .limit: "invalid_limit"
            case .metrics: "invalid_metrics"
            }
        }
    }

    let start: Date
    let end: Date
    let timezone: TimeZone
    let limit: Int
    let metrics: [Metric]

    init(_ input: JSONValue, health: Bool) throws {
        guard case .object(let fields) = input else { throw Invalid.arguments }
        let allowed: Set<String> = health ? ["start", "end", "time_zone", "metrics"] : ["start", "end", "time_zone", "limit"]
        guard Set(fields.keys).isSubset(of: allowed) else { throw Invalid.arguments }
        guard let rawStart = fields["start"]?.string, let rawEnd = fields["end"]?.string,
              let start = Self.date(rawStart), let end = Self.date(rawEnd),
              start < end, end.timeIntervalSince(start) <= 31 * 86_400 else { throw Invalid.dateRange }
        guard let zone = fields["time_zone"]?.string, zone.count <= 100,
              TimeZone.knownTimeZoneIdentifiers.contains(zone) || ["UTC", "GMT"].contains(zone),
              let timezone = TimeZone(identifier: zone) else { throw Invalid.timezone }
        self.start = start
        self.end = end
        self.timezone = timezone
        if health {
            guard case .array(let values) = fields["metrics"], (1...4).contains(values.count) else { throw Invalid.metrics }
            let parsed = values.compactMap { value in value.string.flatMap(Metric.init(rawValue:)) }
            guard parsed.count == values.count, Set(parsed).count == parsed.count else { throw Invalid.metrics }
            metrics = parsed
            limit = 100
        } else {
            if let raw = fields["limit"] {
                guard case .number(let number) = raw, number.isFinite,
                      number.rounded(.towardZero) == number, (1...100).contains(number) else { throw Invalid.limit }
                limit = Int(number)
            } else { limit = 50 }
            metrics = []
        }
    }

    func overlaps(start sampleStart: Date, end sampleEnd: Date) -> Bool {
        guard sampleStart <= sampleEnd else { return false }
        if sampleStart == sampleEnd { return sampleStart >= start && sampleStart < end }
        return sampleStart < end && sampleEnd > start
    }

    var rangeJSON: JSONValue {
        .object(["start": .string(Self.timestamp(start)), "end": .string(Self.timestamp(end)), "interval": .string("[start,end)")])
    }

    static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func date(_ raw: String) -> Date? {
        let pattern = #"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$"#
        guard raw.count <= 40, let match = raw.range(of: pattern, options: .regularExpression),
              match.lowerBound == raw.startIndex, match.upperBound == raw.endIndex else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = raw.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        guard let date = formatter.date(from: raw) else { return nil }
        let offset: Int
        if raw.hasSuffix("Z") { offset = 0 }
        else {
            let suffix = String(raw.suffix(6))
            let parts = suffix.dropFirst().split(separator: ":")
            guard parts.count == 2, let hours = Int(parts[0]), let minutes = Int(parts[1]), hours <= 23, minutes < 60 else { return nil }
            offset = (hours * 3600 + minutes * 60) * (suffix.first == "-" ? -1 : 1)
        }
        guard let zone = TimeZone(secondsFromGMT: offset) else { return nil }
        // ISO parsers may normalize impossible dates. Round-trip the wall clock
        // components so Feb 30, hour 24, and leap-second normalization are rejected.
        let check = DateFormatter()
        check.locale = Locale(identifier: "en_US_POSIX")
        check.calendar = Calendar(identifier: .gregorian)
        check.timeZone = zone
        check.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        guard check.string(from: date) == String(raw.prefix(19)) else { return nil }
        return date
    }
}
