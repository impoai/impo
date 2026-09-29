import XCTest

@MainActor final class TodayUITests: XCTestCase {
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
