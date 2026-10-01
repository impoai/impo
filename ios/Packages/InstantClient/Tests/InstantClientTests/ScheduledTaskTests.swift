import Foundation
import XCTest
@testable import InstantClient

final class ScheduledTaskTests: XCTestCase {
    func testScheduleWireFieldsAndBackwardCompatibleNotificationPreference() throws {
        let daily = ScheduledTaskInput(title: "News", goal: "Research news", schedule: .init(timeZone: "UTC"))
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(JSONValue.object(daily.fields))) as! [String: Any]
        let schedule = body["schedule"] as! [String: Any]
        XCTAssertTrue(schedule["runAt"] is NSNull)
        XCTAssertEqual(schedule["time"] as? String, "09:00")
        XCTAssertEqual(schedule["weekdays"] as? [Int], [])
        let legacy = try JSONDecoder().decode(NotificationPreferences.self, from: Data(#"{"chat":true,"tasks":false,"brief":true}"#.utf8))
        XCTAssertTrue(legacy.scheduledTasks); XCTAssertFalse(legacy.tasks)
        var preferences = legacy; preferences[.scheduledTasks] = false
        XCTAssertFalse(preferences.scheduledTasks); XCTAssertTrue(preferences.chat)
        let id = UUID().uuidString
        let route = try XCTUnwrap(PushRoute(data: ["version": "1", "category": "scheduledTasks", "eventId": id, "registrationId": id, "targetId": id, "expiresAt": "2027-01-01T00:00:00.000Z"]))
        XCTAssertEqual(route.category, .scheduledTasks)
    }
}
