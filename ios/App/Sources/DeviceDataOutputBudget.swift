import Foundation
import InstantClient

/// Reserve space inside the ICA request's 64 KiB limit for its command envelope.
/// Measure encoded UTF-8 bytes, not Swift characters or sample counts.
enum DeviceDataOutputBudget {
    enum Failure: Error { case tooLarge }

    static func bound(_ output: JSONValue, maximumBytes: Int = 48 * 1024) throws -> JSONValue {
        guard case .object(var fields) = output else { throw Failure.tooLarge }
        let encoder = JSONEncoder()
        func fits(_ value: [String: JSONValue]) throws -> Bool {
            try encoder.encode(JSONValue.object(value)).count <= maximumBytes
        }
        if try fits(fields) { return output }

        fields["truncated"] = .bool(true)
        if case .array(let events) = fields["events"] {
            fields = try largestPrefix(events, fields: fields, fits: fits) { current, values in
                var candidate = current
                candidate["events"] = .array(values)
                candidate["returned_count"] = .number(Double(values.count))
                return candidate
            }
        }
        if try fits(fields) { return .object(fields) }

        if case .object(let metrics) = fields["metrics"] {
            // Samples dominate the result; trim those before source metadata.
            let paths = [("sleep", "samples")] + ["steps", "active_energy", "heart_rate"].map { ($0, "sources") }
            for (metric, key) in paths {
                guard case .object(let original) = metrics[metric], case .array(let values) = original[key] else { continue }
                fields = try largestPrefix(values, fields: fields, fits: fits) { current, kept in
                    var candidate = current
                    guard case .object(var currentMetrics) = current["metrics"], case .object(var item) = currentMetrics[metric] else { return current }
                    item[key] = .array(kept)
                    item["truncated"] = .bool(true)
                    if key == "samples" { item["returned_sample_count"] = .number(Double(kept.count)) }
                    currentMetrics[metric] = .object(item)
                    candidate["metrics"] = .object(currentMetrics)
                    return candidate
                }
                if try fits(fields) { return .object(fields) }
            }
        }
        throw Failure.tooLarge
    }

    private static func largestPrefix(_ values: [JSONValue], fields: [String: JSONValue],
                                      fits: ([String: JSONValue]) throws -> Bool,
                                      replacing: ([String: JSONValue], [JSONValue]) -> [String: JSONValue]) throws -> [String: JSONValue] {
        var lower = 0
        var upper = values.count
        // If metadata alone is too large, return the empty array so the caller
        // can trim the next known collection, or reject the whole result.
        var result = replacing(fields, [])
        while lower <= upper {
            let count = lower + (upper - lower) / 2
            let candidate = replacing(fields, Array(values.prefix(count)))
            if try fits(candidate) { result = candidate; lower = count + 1 }
            else { upper = count - 1 }
        }
        return result
    }
}
