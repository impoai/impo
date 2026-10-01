import XCTest

@MainActor final class ScheduledTaskUITests: XCTestCase {
    func testCreatePauseReloadAndDeleteSchedule() async throws {
        continueAfterFailure = false
        let name = "Morning research " + UUID().uuidString.prefix(6)
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", "http://127.0.0.1:3016", "--permission-preview", "allowed"]
        app.launch(); open(app)
        app.buttons["schedule.new"].tap()
        let title = app.textFields["schedule.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10)); title.tap(); title.typeText(name)
        let goal = app.textViews["schedule.goal"].exists ? app.textViews["schedule.goal"] : app.textFields["schedule.goal"]
        goal.tap(); goal.typeText("Research the latest AI news and cite sources.")
        app.buttons["schedule.save"].tap()
        let row = app.buttons.containing(.staticText, identifier: name).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15)); row.tap()
        let enabled = app.switches["schedule.enabled"]
        for _ in 0..<3 where !enabled.isHittable { app.swipeUp() }
        XCTAssertTrue(enabled.waitForExistence(timeout: 10))
        enabled.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        app.buttons["schedule.save"].tap()
        XCTAssertTrue(app.staticTexts["Paused"].waitForExistence(timeout: 10))
        app.terminate(); app.launch(); open(app); row.tap()
        for _ in 0..<3 where !enabled.isHittable { app.swipeUp() }
        XCTAssertEqual(enabled.value as? String, "0")
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Scheduled task and history"; screenshot.lifetime = .keepAlways; add(screenshot)
        let remove = app.buttons["schedule.delete"]
        for _ in 0..<5 where !remove.isHittable { app.swipeUp() }
        remove.tap(); app.sheets.buttons["Delete schedule"].tap()
        XCTAssertTrue(app.buttons["schedule.new"].waitForExistence(timeout: 10))
        XCTAssertFalse(row.exists)
    }
    private func open(_ app: XCUIApplication) {
        XCTAssertTrue(app.buttons["tab.tasks"].waitForExistence(timeout: 20)); app.buttons["tab.tasks"].tap()
        app.buttons["task.segment.scheduled"].tap()
        XCTAssertTrue(app.buttons["schedule.new"].waitForExistence(timeout: 10))
    }
}
