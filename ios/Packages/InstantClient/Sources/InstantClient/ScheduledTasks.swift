import Foundation

public struct TaskSchedule: Codable, Equatable, Sendable {
    public var frequency: String
    public var timeZone: String
    public var runAt: String?
    public var time: String?
    public var weekdays: [Int]
    public init(frequency: String = "daily", timeZone: String = TimeZone.current.identifier, runAt: String? = nil, time: String? = "09:00", weekdays: [Int] = []) {
        self.frequency = frequency; self.timeZone = timeZone; self.runAt = runAt; self.time = time; self.weekdays = weekdays
    }
    var json: JSONValue { .object(["frequency": .string(frequency), "timeZone": .string(timeZone), "runAt": runAt.map(JSONValue.string) ?? .null,
                                  "time": time.map(JSONValue.string) ?? .null, "weekdays": .array(weekdays.sorted().map { .number(Double($0)) })]) }
}
public struct ScheduledTaskInput: Equatable, Sendable {
    public var title: String
    public var goal: String
    public var schedule: TaskSchedule
    public var enabled: Bool
    public init(title: String, goal: String, schedule: TaskSchedule, enabled: Bool = true) {
        self.title = title; self.goal = goal; self.schedule = schedule; self.enabled = enabled
    }
    var fields: [String: JSONValue] { ["title": .string(title), "goal": .string(goal), "schedule": schedule.json, "enabled": .bool(enabled)] }
}
public struct ScheduledTask: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public var title: String
    public var goal: String
    public var schedule: TaskSchedule
    public var enabled: Bool
    public let revision: String
    public let nextRunAt: String?
    public let createdAt: String
    public let updatedAt: String
    public var input: ScheduledTaskInput { .init(title: title, goal: goal, schedule: schedule, enabled: enabled) }
}
public struct ScheduledTaskRun: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let taskId: String?
    public let scheduledAt: String
    public let createdAt: String
    public let status: String
}
public struct ScheduledTaskRunPage: Codable, Sendable { public let runs: [ScheduledTaskRun]; public let nextCursor: String? }
public extension InstantClient {
    func scheduledTasks() async throws -> [ScheduledTask] {
        struct Page: Decodable { let schedules: [ScheduledTask] }
        let page: Page = try await send("GET", ["scheduled-tasks"]); return page.schedules
    }
    func scheduledTask(_ id: String) async throws -> ScheduledTask { try await send("GET", ["scheduled-tasks", id]) }
    func createScheduledTask(_ value: ScheduledTaskInput, clientRequestId: String) async throws -> ScheduledTask {
        var body = value.fields; body["clientRequestId"] = .string(clientRequestId)
        return try await send("POST", ["scheduled-tasks"], body: .object(body))
    }
    func updateScheduledTask(_ id: String, revision: String, value: ScheduledTaskInput) async throws -> ScheduledTask {
        var body = value.fields; body["revision"] = .string(revision)
        return try await send("PUT", ["scheduled-tasks", id], body: .object(body))
    }
    func deleteScheduledTask(_ id: String, revision: String) async throws {
        struct Receipt: Decodable { let deleted: Bool }
        let _: Receipt = try await send("DELETE", ["scheduled-tasks", id], body: .object(["revision": .string(revision)]))
    }
    func scheduledTaskRuns(_ id: String, before: String? = nil) async throws -> ScheduledTaskRunPage {
        try await send("GET", ["scheduled-tasks", id, "runs"], query: before.map { [URLQueryItem(name: "before", value: $0)] } ?? [])
    }
}
