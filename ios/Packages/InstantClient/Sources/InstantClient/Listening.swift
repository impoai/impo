import Foundation

public struct ListeningHistoryPage: Codable, Equatable, Sendable {
    public let segments: [ListeningSegment]
    public let nextCursor: String?
    public var previousCursor: String? = nil
}

public struct ListeningCalendar: Codable, Equatable, Sendable {
    public let timeZone: String
    public let days: [ListeningDay]
}

public struct ListeningDay: Codable, Equatable, Identifiable, Sendable {
    public let date: String
    public let count: Int
    public var id: String { date }
    public init(date: String, count: Int) { self.date = date; self.count = count }
}

/// Complete lightweight inventory. Transcript bodies are fetched only near the viewport.
public struct ListeningTimeline: Codable, Equatable, Sendable {
    public let timeZone: String
    public let days: [ListeningTimelineDay]
}

public struct ListeningTimelineDay: Codable, Equatable, Identifiable, Sendable {
    public let date: String
    public let ids: [String]
    public var id: String { date }
    public init(date: String, ids: [String]) { self.date = date; self.ids = ids }
}

public struct ListeningSegment: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let clientSegmentId: String
    public let startedAt: String
    public let endedAt: String
    public let status: String
    public let transcript: String
    public let model: String?
    public let error: ListeningError?
    public var batchId: String? = nil
    public var segmentCount: Int? = nil
    public var audioMilliseconds: Int? = nil
    public var cursor: String? = nil
    public var location: EchoLocationContext? = nil
}

public struct EchoLocationContext: Codable, Equatable, Sendable {
    public let label: String?
    public let source: String?
    public let spans: [EchoLocationSpan]
    public let truncated: Bool?
    public init(label: String? = nil, source: String? = nil, spans: [EchoLocationSpan] = [], truncated: Bool? = nil) {
        self.label = label; self.source = source; self.spans = spans; self.truncated = truncated
    }
}

/// Resolved place context from the recording device; contains no coordinates.
public struct EchoLocationSpan: Codable, Equatable, Sendable {
    public let from: String
    public let to: String
    public let capturedAt: String
    public let accuracyMeters: Double
    public let source: String
    public let granularity: String
    public let city: String
    public let country: String
    public let district: String?
    public init(from: String, to: String, capturedAt: String, accuracyMeters: Double, source: String = "device",
                granularity: String, city: String, country: String, district: String? = nil) {
        self.from = from; self.to = to; self.capturedAt = capturedAt; self.accuracyMeters = accuracyMeters
        self.source = source; self.granularity = granularity; self.city = city; self.country = country; self.district = district
    }
}

public struct ListeningError: Codable, Equatable, Sendable {
    public let code: String
    public let message: String
    public let retryable: Bool
}

public struct ListeningBatchReceipt: Codable, Equatable, Sendable {
    public let batchId: String
    public let streamId: String
    public let sequence: Int
    public let status: String
}

public struct ListeningUploadTicket: Codable, Sendable {
    public let status: String
    public let url: URL?
    public let headers: [String: String]?
    public let expiresAt: String?
    public let receipt: ListeningBatchReceipt?
}
