import XCTest

@MainActor
final class ConnectorsUITests: XCTestCase {
    func testOfflineAppsExplainLiveRequirementWithoutAuthorization() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main"]
        app.launch()
        let settings = app.buttons["chat.settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()
        let connections = app.buttons["settings.connections"]
        for _ in 0..<6 where !connections.isHittable { app.swipeUp() }
        XCTAssertTrue(connections.isHittable)
        connections.tap()
        let notice = app.staticTexts["connection.apps.offline"]
        for _ in 0..<6 where !notice.isHittable { app.swipeUp() }
        XCTAssertTrue(notice.isHittable)
        XCTAssertTrue(notice.label.contains("offline Demo"))
        XCTAssertFalse(app.buttons["connection.apps.browse"].exists)
        XCTAssertFalse(app.buttons["connector.gmail"].exists)
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "App connections in offline Demo"
        capture.lifetime = .keepAlways
        add(capture)
    }
}
