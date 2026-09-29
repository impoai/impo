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
        XCTAssertEqual(notice.label, "Sign in to connect apps.")
        XCTAssertFalse(app.buttons["connection.apps.browse"].exists)
        XCTAssertFalse(app.buttons["connector.gmail"].exists)
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "App connections in offline Demo"
        capture.lifetime = .keepAlways
        add(capture)
    }

    func testSevenAvatarTapsToggleDebugMode() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main"]
        app.launch()
        let settings = app.buttons["chat.settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()
        let avatar = app.descendants(matching: .any)["settings.avatar"]
        XCTAssertTrue(avatar.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["settings.manage"].exists)
        XCTAssertFalse(app.buttons["settings.listening-debug"].exists)
        for _ in 0..<6 { avatar.tap() }
        XCTAssertFalse(app.buttons["settings.manage"].exists, "Six taps are not enough")
        avatar.tap()
        let manage = app.buttons["settings.manage"]
        XCTAssertTrue(manage.waitForExistence(timeout: 3))
        let logs = app.buttons["settings.listening-debug"]
        for _ in 0..<6 where !logs.isHittable { app.swipeUp() }
        XCTAssertTrue(logs.isHittable)
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "Settings in Debug mode"
        capture.lifetime = .keepAlways
        add(capture)
        app.buttons["settings.debug-off"].tap()
        XCTAssertFalse(app.buttons["settings.manage"].waitForExistence(timeout: 2))
    }
}
