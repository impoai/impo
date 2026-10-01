import XCTest

@MainActor final class SoftUpgradeUITests: XCTestCase {
    func testLaterAllowsUseAndWarmResumeDoesNotRepeatButColdStartDoes() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main"]
        app.launchEnvironment["IMPO_TEST_RELEASE_JSON"] = #"{"schemaVersion":1,"platform":"ios","channel":"testflight","latest":{"version":"1.0","build":999,"minimumSystemVersion":"18.0","url":"https://testflight.apple.com/join/Wgkx6k3V","expiresAt":"2099-01-01T00:00:00Z"}}"#
        app.launch()
        let alert = app.alerts["Update available"]
        XCTAssertTrue(alert.waitForExistence(timeout: 15)); XCTAssertTrue(alert.buttons["Update"].exists)
        alert.buttons["Later"].tap()
        XCTAssertFalse(alert.exists)
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertFalse(alert.waitForExistence(timeout: 3))
        app.terminate(); app.launch()
        XCTAssertTrue(alert.waitForExistence(timeout: 15)); alert.buttons["Later"].tap()
    }
    func testCurrentVersionDoesNotPrompt() {
        let app = XCUIApplication(); app.launchArguments = ["--reset-demo", "--show-main"]
        app.launchEnvironment["IMPO_TEST_RELEASE_JSON"] = #"{"schemaVersion":1,"platform":"ios","channel":"testflight","latest":{"version":"1.0","build":49,"minimumSystemVersion":"18.0","url":"https://testflight.apple.com/join/Wgkx6k3V","expiresAt":"2099-01-01T00:00:00Z"}}"#
        app.launch(); XCTAssertFalse(app.alerts["Update available"].waitForExistence(timeout: 5))
    }
}
