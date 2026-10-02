import Foundation

public struct TodaySlot: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public var label: String
    public var hour: Int
    public var enabled: Bool
    public init(id: String, label: String, hour: Int, enabled: Bool) { self.id = id; self.label = label; self.hour = hour; self.enabled = enabled }
}
public struct TodayLocation: Codable, Equatable, Sendable {
    public enum Source: String, Codable, Sendable { case device, manual }
    public let city: String
    public let country: String
    public let capturedAt: String
    public let source: Source?
    public init(city: String, country: String, capturedAt: String, source: Source? = nil) { self.city = city; self.country = country; self.capturedAt = capturedAt; self.source = source }
}
public struct TodaySettings: Codable, Equatable, Sendable {
    public var timeZone: String
    public var locale: String
    public var displayName: String
    public var location: TodayLocation?
    public var slots: [TodaySlot]
    public var contentPreferences: TodayContentPreferences?
}
public struct TodayContentPreferences: Codable, Equatable, Sendable {
    public var categories: [String: Bool]
    public var occasionCalendar: String
    public init(categories: [String: Bool] = ["suggestion": true, "recap": true, "connect": true, "feature": true, "occasion": true], occasionCalendar: String = "none") {
        self.categories = categories; self.occasionCalendar = occasionCalendar
    }
}
public struct TodaySettingsResponse: Codable, Sendable { public let settings: TodaySettings? }
public struct TodayPage: Codable, Sendable { public let briefs: [TodayBrief]; public let nextCursor: String? }
public struct TodayBrief: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let localDate: String
    public let timeZone: String
    public let kind: String
    public let label: String
    public let scheduledAt: String
    public let createdAt: String
    public let completedAt: String?
    public let status: String
    public let content: TodayContent?
    public let errorCode: String?
    public let inputCutoff: String?
    public let inputTruncated: Bool
    public let sources: [TodaySource]
}
public struct TodayContent: Codable, Equatable, Sendable {
    public let title: String
    public let summary: String
    public let cards: [TodayCard]
}
public struct TodayCard: Codable, Equatable, Sendable {
    public let id: String?
    public let type: String?
    public let expiresAt: String?
    public let action: TodayAction?
    public let style: String
    public let eyebrow: String
    public let title: String
    public let body: String
    public let bullets: [String]
    public let sourceIds: [String]
    public let links: [TodayLink]
}
public struct TodayAction: Codable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let target: String
    public let label: String
    public let prompt: String?
}
public struct TodayActionResponse: Codable, Sendable { public let action: TodayAction }
public struct TodayLink: Codable, Equatable, Sendable { public let title: String; public let url: String }
public struct TodaySource: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let kind: String
    public let recordId: String
    public let title: String
    public let occurredAt: String
    public let version: String
    public let text: String?
}
