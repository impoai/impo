import XCTest

/// Requires a real microphone route. Headless iOS Simulators may hang inside
/// the OS AudioQueue service; use a physical iPhone for hardware qualification.
@MainActor
final class ListeningCaptureLiveUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }
    /// Requires the isolated local probe app; exercises real OS session notifications,
    /// not injected notifications. The probe records nothing and sends nothing.
    func testOtherAppReleasesMicrophoneAndListeningResumesWithoutOpeningImpo() throws {
        guard let backend = ProcessInfo.processInfo.environment["IMPO_UI_LIVE_BACKEND"],
              ProcessInfo.processInfo.environment["IMPO_MICROPHONE_PROBE"] == "1" else {
            throw XCTSkip("Requires local API and installed ai.impo.interruptionqa microphone probe")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", backend]
        app.launch()
        XCTAssertTrue(app.buttons["listening.toggle"].waitForExistence(timeout: 10))
        app.buttons["listening.toggle"].tap()
        XCTAssertTrue(app.buttons["listening.agree"].waitForExistence(timeout: 5))
        app.buttons["listening.agree"].tap()
        XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 15))
        let probe = XCUIApplication(bundleIdentifier: "ai.impo.interruptionqa")
        probe.launch()
        defer { probe.terminate() }
        probe.buttons["probe.start"].tap()
        XCTAssertTrue(probe.staticTexts["Microphone occupied"].waitForExistence(timeout: 10))
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        func showActivity() {
            XCUIDevice.shared.press(.home)
            let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.01))
            let bottom = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.75))
            top.press(forDuration: 0.1, thenDragTo: bottom)
            if springboard.buttons["Allow"].waitForExistence(timeout: 1) { springboard.buttons["Allow"].tap() }
        }
        func attach(_ title: String) {
            let shot = XCTAttachment(screenshot: springboard.screenshot()); shot.name = title; shot.lifetime = .keepAlways; add(shot)
            let tree = XCTAttachment(string: springboard.debugDescription); tree.name = title + " accessibility"; tree.lifetime = .keepAlways; add(tree)
        }
        showActivity()
        attach("Microphone occupied by another app")
        XCTAssertTrue(springboard.staticTexts["Listening paused"].waitForExistence(timeout: 8))
        probe.activate()
        probe.buttons["probe.stop"].tap()
        XCTAssertTrue(probe.staticTexts["Microphone released"].waitForExistence(timeout: 5))
        showActivity()
        // Impo remains in the background. Foreground fallback cannot make this pass.
        XCTAssertTrue(springboard.staticTexts["Listening"].waitForExistence(timeout: 12))
        XCTAssertFalse(springboard.staticTexts["Listening paused"].exists)
        attach("Listening automatically resumed in background")
        app.activate()
        XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 10) // Allow the stalled-input watchdog to detect a false resume.
        XCTAssertFalse(app.buttons["listening.resume"].exists)
        app.buttons["listening.stop"].tap()
        probe.terminate()
    }

    func testListeningAndMusicCoexistInBothStartOrders() throws {
        guard let backend = ProcessInfo.processInfo.environment["IMPO_UI_LIVE_BACKEND"],
              ProcessInfo.processInfo.environment["IMPO_MICROPHONE_PROBE"] == "1" else {
            throw XCTSkip("Requires local API and isolated audio probe")
        }
        let probe = XCUIApplication(bundleIdentifier: "ai.impo.interruptionqa")
        probe.launch()
        defer { probe.terminate() }
        probe.buttons["probe.music"].tap()
        XCTAssertTrue(probe.staticTexts["Music playing"].waitForExistence(timeout: 5))
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", backend]
        app.launch()
        XCTAssertTrue(app.buttons["listening.toggle"].waitForExistence(timeout: 10))
        app.buttons["listening.toggle"].tap()
        XCTAssertTrue(app.buttons["listening.agree"].waitForExistence(timeout: 5))
        app.buttons["listening.agree"].tap()
        XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 15))
        probe.activate()
        XCTAssertTrue(probe.staticTexts["Music playing"].waitForExistence(timeout: 5), "Starting Listening must preserve existing playback")
        probe.buttons["probe.stop"].tap()
        probe.buttons["probe.music"].tap()
        XCTAssertTrue(probe.staticTexts["Music playing"].waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 12) // Includes input watchdog, with Impo in background.
        XCUIDevice.shared.press(.home)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.01))
        let bottom = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.75))
        top.press(forDuration: 0.1, thenDragTo: bottom)
        if springboard.buttons["Always Allow"].waitForExistence(timeout: 1) { springboard.buttons["Always Allow"].tap() }
        else if springboard.buttons["Allow"].waitForExistence(timeout: 1) { springboard.buttons["Allow"].tap() }
        XCTAssertTrue(springboard.staticTexts["Listening"].waitForExistence(timeout: 8), "Playback started later must preserve background Listening")
        XCTAssertFalse(springboard.staticTexts["Listening paused"].exists)
        let image = XCTAttachment(screenshot: springboard.screenshot()); image.name = "Listening continues alongside probe playback"; image.lifetime = .keepAlways; add(image)
        app.activate()
        XCTAssertFalse(app.buttons["listening.resume"].exists)
        app.buttons["listening.stop"].tap()
        probe.activate()
        XCTAssertTrue(probe.staticTexts["Music playing"].waitForExistence(timeout: 5))
        probe.buttons["probe.stop"].tap()
    }

    func testManualRecordingContinuesInBackgroundAndStops() throws {
        guard let backend = ProcessInfo.processInfo.environment["IMPO_UI_LIVE_BACKEND"] else { throw XCTSkip("Requires the local development API") }
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", backend]
        app.launch()
        XCTAssertTrue(app.buttons["listening.toggle"].waitForExistence(timeout: 10))
        app.buttons["listening.toggle"].tap()
        XCTAssertTrue(app.buttons["listening.agree"].waitForExistence(timeout: 5))
        app.buttons["listening.agree"].tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 3) { allow.tap() }
        XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 15))
        let start = XCTAttachment(screenshot: app.screenshot()); start.name = "Recording active"; start.lifetime = .keepAlways; add(start)
        XCUIDevice.shared.press(.home)
        // Return after the app has actually transitioned to the background.
        XCTAssertTrue(springboard.wait(for: .runningForeground, timeout: 5))
        Thread.sleep(forTimeInterval: 12) // Exercise real background audio and the stalled-input watchdog.
        app.activate()
        XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["listening.resume"].exists)
        app.buttons["listening.stop"].tap()
        XCTAssertFalse(app.buttons["listening.stop"].exists)
        XCTAssertEqual(app.buttons["listening.toggle"].label, "Start listening")
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["listening.toggle"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["listening.stop"].exists, "Never restart the microphone without a tap")
    }
}
