import XCTest
import CoreLocation
import EventKit
import HealthKit
import InstantClient
@testable import Instant

@MainActor
final class DeviceDataTests: XCTestCase {
    private func input(_ overrides: [String: JSONValue] = [:], health: Bool = false) -> JSONValue {
        var fields: [String: JSONValue] = [
            "start": .string("2026-09-01T00:00:00Z"), "end": .string("2026-09-02T00:00:00Z"),
            "time_zone": .string("Asia/Shanghai")
        ]
        if health { fields["metrics"] = .array([.string("steps"), .string("sleep")]) }
        fields.merge(overrides) { _, new in new }
        return .object(fields)
    }

    func testDateRangeTimezoneAndLimits() throws {
        let accepted = try DeviceDataInput(input(["end": .string("2026-10-02T00:00:00Z"), "limit": .number(100)]), health: false)
        XCTAssertEqual(accepted.end.timeIntervalSince(accepted.start), 31 * 86_400)
        XCTAssertEqual(accepted.limit, 100)
        XCTAssertEqual(accepted.timezone.identifier, "Asia/Shanghai")
        let invalid: [[String: JSONValue]] = [
            ["end": .string("2026-10-02T00:00:01Z")],
            ["end": .string("2026-09-01T00:00:00Z")],
            ["start": .string("2026-02-30T00:00:00Z")],
            ["start": .string("2026-09-01T00:00:00")],
            ["time_zone": .string("Invalid/Zone")],
            ["limit": .number(0)], ["limit": .number(101)], ["limit": .number(1.5)],
            ["unexpected": .bool(true)]
        ]
        for arguments in invalid { XCTAssertThrowsError(try DeviceDataInput(input(arguments), health: false)) }
        _ = try DeviceDataInput(input(["start": .string("2024-02-29T00:00:00+08:00"), "end": .string("2024-03-01T00:00:00+08:00")]), health: false)
    }

    func testHealthMetricValidationAndHalfOpenInterval() throws {
        _ = try DeviceDataInput(input(health: true), health: true)
        for metrics: [JSONValue] in [[], [.string("steps"), .string("steps")], [.string("blood_pressure")], [.number(1)]] {
            XCTAssertThrowsError(try DeviceDataInput(input(["metrics": .array(metrics)], health: true), health: true))
        }
        let window = try DeviceDataInput(input(), health: false)
        XCTAssertFalse(window.overlaps(start: window.end, end: window.end.addingTimeInterval(1)))
        XCTAssertFalse(window.overlaps(start: window.start.addingTimeInterval(-1), end: window.start))
        XCTAssertFalse(window.overlaps(start: window.end, end: window.end))
        XCTAssertTrue(window.overlaps(start: window.start, end: window.start))
        XCTAssertTrue(window.overlaps(start: window.start.addingTimeInterval(-1), end: window.start.addingTimeInterval(1)))
    }

    func testUTF8BudgetTrimsEventsAndSleepWithoutFabricatingTotals() throws {
        let text = String(repeating: "中文日历", count: 180)
        let events = (0..<100).map { JSONValue.object(["title": .string(text), "id": .number(Double($0))]) }
        let result = try DeviceDataOutputBudget.bound(.object(["events": .array(events), "returned_count": .number(100), "truncated": .bool(false)]))
        XCTAssertLessThanOrEqual(try JSONEncoder().encode(result).count, 48 * 1024)
        XCTAssertEqual(result["truncated"], .bool(true))
        guard case .array(let kept) = result["events"] else { return XCTFail("Missing events") }
        XCTAssertGreaterThan(kept.count, 0)
        XCTAssertLessThan(kept.count, 100)
        XCTAssertEqual(result["returned_count"], .number(Double(kept.count)))
        let sleep = try DeviceDataOutputBudget.bound(.object([
            "truncated": .bool(false), "metrics": .object(["sleep": .object([
                "samples": .array(events), "total_sleep_seconds": .null, "truncated": .bool(false)
            ])])
        ]))
        XCTAssertLessThanOrEqual(try JSONEncoder().encode(sleep).count, 48 * 1024)
        XCTAssertEqual(sleep["metrics"]?["sleep"]?["total_sleep_seconds"], .null)
        XCTAssertEqual(sleep["metrics"]?["sleep"]?["truncated"], .bool(true))
        XCTAssertThrowsError(try DeviceDataOutputBudget.bound(.object(["unbounded": .string(String(repeating: text, count: 100))])))
    }

    func testHandlersNeverRequestPermissionDuringExecution() async throws {
        let suite = "instant-native-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let service = DeviceDataService(defaults: defaults)
        XCTAssertFalse(service.healthAccessRequested)
        let health = await service.execute(toolName: "ios_get_health_summary", input: input(health: true))
        XCTAssertFalse(health.success)
        XCTAssertEqual(health.error, HKHealthStore.isHealthDataAvailable() ? "permission_required" : "health_unavailable")
        XCTAssertFalse(service.healthAccessRequested)

        let before = EKEventStore.authorizationStatus(for: .event)
        let calendar = await service.execute(toolName: "ios_list_calendar_events", input: input())
        XCTAssertEqual(EKEventStore.authorizationStatus(for: .event), before)
        if before != .fullAccess {
            XCTAssertFalse(calendar.success)
            XCTAssertEqual(calendar.error, "permission_required")
        } else { XCTAssertTrue(calendar.success) }
        let unsupported = await service.execute(toolName: "ios_read_messages", input: .object([:]))
        XCTAssertEqual(unsupported.error, "unsupported_tool")
    }

    func testCancelledExecutionCannotStartARead() async {
        let service = DeviceDataService()
        let arguments = input()
        let task = Task { await service.execute(toolName: "ios_list_calendar_events", input: arguments) }
        task.cancel()
        let result = await task.value
        XCTAssertFalse(result.success)
        XCTAssertEqual(result.error, "cancelled")
    }
}

@MainActor
final class CurrentLocationReaderTests: XCTestCase {
    /// Needs location access granted to the host app and a simulated position, e.g.
    /// `xcrun simctl privacy <device> grant location <bundle>` and `xcrun simctl location <device> set 31.2397,121.4998`.
    func testReadsFixAndPlaceWithGrantedAccess() async throws {
        guard CurrentLocationReader.authorized else { throw XCTSkip("Location access is not granted to the test host") }
        let started = Date()
        guard case .object(let output) = try await CurrentLocationReader().read() else { return XCTFail("Expected an object") }
        XCTAssertLessThan(Date().timeIntervalSince(started), 10, "A fix settles within five seconds plus geocoding")
        XCTAssertEqual(output["source"], .string("ios.core_location"))
        guard case .number(let latitude) = output["latitude"], case .number(let longitude) = output["longitude"],
              case .number(let accuracy) = output["horizontal_accuracy_m"], case .bool(let precise) = output["precise"] else { return XCTFail("Missing coordinates") }
        // Approximate Location deliberately blurs the fix by kilometers and must say so.
        let tolerance = precise ? 0.01 : 0.1
        XCTAssertEqual(latitude, 31.2397, accuracy: tolerance)
        XCTAssertEqual(longitude, 121.4998, accuracy: tolerance)
        if !precise { XCTAssertGreaterThan(accuracy, 500) }
        if case .object(let place) = output["place"] { XCTAssertNotEqual(place["country"], .null) }
    }

    func testDispatcherRejectsArgumentsForCurrentLocation() async {
        let result = await DeviceDataService().execute(toolName: "impo_get_current_location", input: .object(["precise": .bool(true)]))
        XCTAssertFalse(result.success)
        XCTAssertEqual(result.error, "invalid_input")
    }
}
