import XCTest

@MainActor final class TodayUITests: XCTestCase {
    func testGuidanceOpensAnEditableDraftAndPreservesExistingText() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", "http://127.0.0.1:3018"]
        app.launch()
        let input = app.textViews["chat.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 20))
        input.tap(); input.typeText("Keep my unfinished message")
        app.scrollViews.firstMatch.swipeDown()
        XCTAssertTrue(app.buttons["tab.today"].waitForExistence(timeout: 5))
        app.buttons["tab.today"].tap()
        let action = app.buttons["today.action.aaaaaaaaaaaaaaaaaaaaaaaa"].firstMatch
        XCTAssertTrue(action.waitForExistence(timeout: 15))
        for _ in 0..<5 where !action.isHittable { app.swipeUp() }
        snapshot("Brief next action", app)
        action.tap()
        XCTAssertTrue(app.buttons["Keep current draft"].waitForExistence(timeout: 10))
        app.buttons["Keep current draft"].tap()
        XCTAssertEqual(input.value as? String, "Keep my unfinished message")
        app.buttons["tab.today"].tap()
        for _ in 0..<5 where !action.isHittable { app.swipeUp() }
        action.tap()
        XCTAssertTrue(app.buttons["Replace draft"].waitForExistence(timeout: 10))
        app.buttons["Replace draft"].tap()
        XCTAssertEqual(input.value as? String, "Help me choose the smallest useful next step for my project.")
        XCTAssertFalse(app.staticTexts["Keep my unfinished message"].exists, "The draft was not sent")
        snapshot("Brief editable draft", app)
        app.scrollViews.firstMatch.swipeDown()
        XCTAssertTrue(app.buttons["tab.today"].waitForExistence(timeout: 5))
        app.buttons["tab.today"].tap()
        for _ in 0..<6 where !app.buttons["today.settings"].isHittable { app.swipeDown() }
        app.buttons["today.settings"].tap()
        let tips = app.switches["today.category.feature"]
        XCTAssertTrue(tips.waitForExistence(timeout: 10))
        if tips.value as? String == "1" { tips.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap() }
        XCTAssertEqual(tips.value as? String, "0")
        snapshot("Brief content preferences", app)
        app.buttons["today.settings-save"].tap()
        XCTAssertTrue(app.buttons["today.settings"].waitForExistence(timeout: 10)); app.buttons["today.settings"].tap()
        XCTAssertEqual(tips.value as? String, "0")
    }
    func testTimelineAndFullDayCapture() {
        let app = XCUIApplication(); app.launchArguments = ["--reset-demo", "--show-main", "--today-preview"]
        app.launch()
        let tab = app.buttons["tab.today"]; XCTAssertTrue(tab.waitForExistence(timeout: 10)); tab.tap()
        let capture = app.buttons["today.capture"]
        XCTAssertTrue(capture.waitForExistence(timeout: 10)); XCTAssertTrue(capture.isEnabled)
        snapshot("Today timeline", app)
        capture.tap()
        XCTAssertTrue(app.buttons["today.capture-share"].waitForExistence(timeout: 20))
        snapshot("Full-day capture preview", app)
        app.swipeUp(); app.swipeUp()
        snapshot("Offscreen cards in capture preview", app)
    }
    func testScreenshotNotificationOffersFullPageCapture() {
        let app = XCUIApplication(); app.launchArguments = ["--reset-demo", "--show-main", "--today-preview", "--today-screenshot-notification"]
        app.launch(); let tab = app.buttons["tab.today"]; XCTAssertTrue(tab.waitForExistence(timeout: 10)); tab.tap()
        let offer = app.buttons["today.capture-offer"]; XCTAssertTrue(offer.waitForExistence(timeout: 10))
        snapshot("Screenshot capture offer", app); offer.tap()
        XCTAssertTrue(app.buttons["today.capture-share"].waitForExistence(timeout: 20))
    }
    private func snapshot(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
