import XCTest

@MainActor final class ModelModeUITests: XCTestCase {
    func testModeIsVisibleOutsideDebugAndRestoredAfterRelaunch() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", "http://127.0.0.1:3016"]
        app.launch(); open(app)
        let power = app.buttons["settings.mode.power"]
        power.tap()
        XCTAssertTrue(NSPredicate(format: "selected == true AND enabled == true").evaluateEventually(power))
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "Model mode selection"; shot.lifetime = .keepAlways; add(shot)
        app.terminate()
        app.launchArguments = ["--show-main", "--live-backend", "http://127.0.0.1:3016"]
        app.launch(); open(app)
        XCTAssertTrue(power.isSelected)
        let balanced = app.buttons["settings.mode.balanced"]
        balanced.tap()
        XCTAssertTrue(NSPredicate(format: "selected == true AND enabled == true").evaluateEventually(balanced))
    }
    func testLegacyServerShowsDisabledModePreviewWithoutAnActiveSelection() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", "http://127.0.0.1:3017"]
        app.launch()
        XCTAssertTrue(app.buttons["chat.settings"].waitForExistence(timeout: 20))
        app.buttons["chat.settings"].tap()
        let power = app.buttons["settings.mode.power"]
        for _ in 0..<4 where !power.isHittable { app.swipeUp() }
        XCTAssertTrue(power.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Model switching is coming soon. Your current model stays active."].waitForExistence(timeout: 10))
        XCTAssertFalse(power.isEnabled)
        XCTAssertFalse(power.isSelected)
        let balanced = app.buttons["settings.mode.balanced"]
        XCTAssertFalse(balanced.isEnabled)
        XCTAssertFalse(balanced.isSelected)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "Unavailable model preview"; shot.lifetime = .keepAlways; add(shot)
    }

    private func open(_ app: XCUIApplication) {
        XCTAssertTrue(app.buttons["chat.settings"].waitForExistence(timeout: 20))
        app.buttons["chat.settings"].tap()
        let power = app.buttons["settings.mode.power"]
        for _ in 0..<4 where !power.isHittable { app.swipeUp() }
        XCTAssertTrue(power.waitForExistence(timeout: 10))
        XCTAssertTrue(NSPredicate(format: "enabled == true").evaluateEventually(power))
        XCTAssertFalse(app.buttons["settings.manage"].exists)
    }
}
private extension NSPredicate {
    func evaluateEventually(_ element: XCUIElement) -> Bool {
        XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: self, object: element)], timeout: 10) == .completed
    }
}
