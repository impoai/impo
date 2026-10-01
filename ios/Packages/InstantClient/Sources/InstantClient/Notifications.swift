import Foundation

public enum NotificationCategory: String, Codable, Sendable, CaseIterable { case chat, tasks, brief, echo }
public struct NotificationPreferences: Codable, Equatable, Sendable {
    public var chat: Bool
    public var tasks: Bool
    public var brief: Bool
    public var echo: Bool
    public init(chat: Bool = true, tasks: Bool = true, brief: Bool = true, echo: Bool = true) { self.chat = chat; self.tasks = tasks; self.brief = brief; self.echo = echo }
    enum CodingKeys: String, CodingKey { case chat, tasks, brief, echo }
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        chat = try values.decode(Bool.self, forKey: .chat); tasks = try values.decode(Bool.self, forKey: .tasks); brief = try values.decode(Bool.self, forKey: .brief)
        echo = try values.decodeIfPresent(Bool.self, forKey: .echo) ?? true
    }
    public subscript(_ category: NotificationCategory) -> Bool {
        get { switch category { case .chat: chat; case .tasks: tasks; case .brief: brief; case .echo: echo } }
        set { switch category { case .chat: chat = newValue; case .tasks: tasks = newValue; case .brief: brief = newValue; case .echo: echo = newValue } }
    }
}
public struct PushRegistrationReceipt: Decodable, Sendable { public let registrationId: String }
public struct PushRoute: Codable, Equatable, Sendable, Identifiable {
    public let eventId: String
    public let registrationId: String
    public let category: NotificationCategory
    public let targetId: String
    public let expiresAt: String
    public var id: String { eventId }
    public init?(data: [String: String]) {
        guard data["version"] == "1", let event = data["eventId"], UUID(uuidString: event) != nil,
              let registration = data["registrationId"], UUID(uuidString: registration) != nil,
              let target = data["targetId"], UUID(uuidString: target) != nil,
              let category = NotificationCategory(rawValue: data["category"] ?? ""), let expires = data["expiresAt"] else { return nil }
        eventId = event; registrationId = registration; targetId = target; self.category = category; expiresAt = expires
    }
    public func isCurrent(registration: String?, now: Date = Date()) -> Bool {
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return registrationId.lowercased() == registration?.lowercased() && (parser.date(from: expiresAt) ?? .distantPast) > now
    }
}
public extension InstantClient {
    func notificationPreferences() async throws -> NotificationPreferences { try await send("GET", ["notifications", "settings"]) }
    func updateNotificationPreference(_ category: NotificationCategory, enabled: Bool) async throws -> NotificationPreferences {
        try await send("PATCH", ["notifications", "settings"], body: .object([category.rawValue: .bool(enabled)]))
    }
    func registerPush(installationId: String, installationSecret: String, revision: Int, registrationId: String, token: String?, enabled: Bool, foreground: Bool) async throws -> PushRegistrationReceipt {
        try await send("PUT", ["notifications", "installations", installationId], body: .object([
            "installationSecret": .string(installationSecret), "revision": .number(Double(revision)), "registrationId": .string(registrationId),
            "platform": .string("ios"), "token": token.map(JSONValue.string) ?? .null, "enabled": .bool(enabled), "foreground": .bool(foreground),
        ]))
    }
    func revokePush(installationId: String, installationSecret: String, revision: Int, registrationId: String) async throws {
        struct Receipt: Decodable { let revoked: Bool }
        let _: Receipt = try await send("DELETE", ["notifications", "installations", installationId], body: .object([
            "installationSecret": .string(installationSecret), "revision": .number(Double(revision)), "registrationId": .string(registrationId),
        ]))
    }
}
