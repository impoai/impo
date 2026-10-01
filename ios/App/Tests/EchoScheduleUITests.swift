import XCTest

@MainActor final class EchoScheduleUITests: XCTestCase {
    func testScheduleSavesAndReloadsWithoutStartingMicrophone() async throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", "http://127.0.0.1:3016", "--permission-preview", "allowed"]
        app.launch(); open(app)
        let save = app.buttons["echo.schedule.save"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: save)], timeout: 20), .completed)
        let enabled = app.switches["echo.schedule.enabled"]
        if enabled.value as? String == "0" { enabled.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap() }
        let saturday = app.switches["echo.schedule.day.6"]
        saturday.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        let saturdayOn = saturday.value as? String == "1"
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Echo schedule"; screenshot.lifetime = .keepAlways; add(screenshot)
        save.tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: save)], timeout: 10), .completed)
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3016/api/v1/echo/schedule")!)
        request.setValue("Bearer instant-dev-alice", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let value = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(value["enabled"] as? Bool, true)
        XCTAssertEqual((value["weekdays"] as? [Int])?.contains(6), saturdayOn)
        app.terminate(); app.launch(); open(app)
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: save)], timeout: 20), .completed)
        XCTAssertEqual(enabled.value as? String, "1")
        XCTAssertEqual(saturday.value as? String, saturdayOn ? "1" : "0")
        enabled.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap(); save.tap()
    }
    private func open(_ app: XCUIApplication) {
        XCTAssertTrue(app.buttons["chat.settings"].waitForExistence(timeout: 20)); app.buttons["chat.settings"].tap()
        let schedule = app.buttons["settings.echo-schedule"]
        for _ in 0..<4 where !schedule.isHittable { app.swipeUp() }
        XCTAssertTrue(schedule.waitForExistence(timeout: 10)); schedule.tap()
        XCTAssertTrue(app.switches["echo.schedule.enabled"].waitForExistence(timeout: 10))
    }
}
