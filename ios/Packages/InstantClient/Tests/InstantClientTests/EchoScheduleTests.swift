import Foundation
import XCTest
@testable import InstantClient

final class EchoScheduleTests: XCTestCase {
    private func date(_ string: String) -> Date { ISO8601DateFormatter().date(from: string)! }
    func testOptInWeekdaysTimeZoneAndAbsoluteStop() {
        var plan = EchoSchedule(timeZone: "Asia/Shanghai")
        XCTAssertNil(plan.nextStop(after: date("2026-10-01T01:15:00Z")))
        plan.enabled = true
        XCTAssertEqual(plan.nextStop(after: date("2026-10-01T01:15:00Z")), date("2026-10-01T10:00:00Z"))
        XCTAssertEqual(plan.nextStop(after: date("2026-10-02T11:00:00Z")), date("2026-10-05T10:00:00Z"))
        plan.autoStop = false; XCTAssertNil(plan.nextStop(after: Date()))
    }
    func testDSTGapAndRepeatedTimeMatchServer() {
        var plan = EchoSchedule(enabled: true, weekdays: [7], reminderTime: "00:00", stopTime: "02:30", timeZone: "America/New_York")
        XCTAssertEqual(plan.nextStop(after: date("2026-03-08T05:00:00Z")), date("2026-03-08T07:30:00Z"))
        plan.stopTime = "01:30"
        XCTAssertEqual(plan.nextStop(after: date("2026-11-01T04:00:00Z")), date("2026-11-01T05:30:00Z"))
        XCTAssertEqual(plan.nextStop(after: date("2026-11-01T05:45:00Z")), date("2026-11-08T06:30:00Z"))
    }
    func testInvalidSchedulesCannotSetRecordingDeadlines() {
        var plan = EchoSchedule(enabled: true)
        plan.weekdays = []; XCTAssertFalse(plan.isValid); XCTAssertNil(plan.nextStop(after: Date()))
        plan.weekdays = [1]; plan.timeZone = "Invalid/Zone"; XCTAssertFalse(plan.isValid)
        plan.timeZone = "UTC"; plan.stopTime = "08:00"; XCTAssertFalse(plan.isValid)
    }
}
