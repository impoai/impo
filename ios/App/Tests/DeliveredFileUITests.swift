import XCTest

/// Run the synthetic fixture: node --import tsx scripts/android-ui-fixture.ts --port 3017 --files
@MainActor final class DeliveredFileUITests: XCTestCase {
    func testTaskFileOpensQuickLookAndSurvivesRelaunch() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", "http://127.0.0.1:3017", "--permission-preview", "allowed"]
        app.launch()
        openFile(app)
        capture("Delivered PDF preview", app)
        app.buttons["QLOverlayDoneButtonAccessibilityIdentifier"].tap()
        app.terminate(); app.launch()
        openFile(app)
        capture("Delivered PDF after relaunch", app)
    }

    private func openFile(_ app: XCUIApplication) {
        let tab = app.buttons["tab.tasks"]
        XCTAssertTrue(tab.waitForExistence(timeout: 20), app.debugDescription)
        if app.buttons["Not now"].waitForExistence(timeout: 1) { app.buttons["Not now"].tap() }
        tab.tap()
        let task = app.buttons.matching(identifier: "task.row").firstMatch
        XCTAssertTrue(task.waitForExistence(timeout: 15), app.debugDescription)
        task.tap()
        let file = app.buttons.matching(identifier: "message.file").firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(file.label.contains("Impo download test.pdf"))
        capture("Task reply with a delivered file", app)
        file.tap()
        XCTAssertTrue(app.buttons["QLOverlayDoneButtonAccessibilityIdentifier"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Impo file download verified"].waitForExistence(timeout: 5), app.debugDescription)
    }

    private func capture(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
