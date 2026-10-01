import XCTest
@testable import Instant

final class ScheduledClockTests: XCTestCase {
    func testChangingZonesPreservesRecurringWallClockInsteadOfConvertingTheInstant() {
        let shanghai = scheduledClockDate("09:00", timeZone: "Asia/Shanghai")
        let newYork = scheduledClockDate("09:00", timeZone: "America/New_York")
        XCTAssertNotEqual(shanghai, newYork)
        XCTAssertEqual(scheduledClockString(shanghai, timeZone: "Asia/Shanghai"), "09:00")
        XCTAssertEqual(scheduledClockString(newYork, timeZone: "America/New_York"), "09:00")
        for zone in ["UTC", "Asia/Kolkata", "Pacific/Chatham"] {
            XCTAssertEqual(scheduledClockString(scheduledClockDate("23:45", timeZone: zone), timeZone: zone), "23:45")
        }
    }
}
