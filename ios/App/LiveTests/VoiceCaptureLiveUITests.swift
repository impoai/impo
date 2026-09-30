import XCTest

/// Opt-in, isolated physical-device app; never reset the user's installed app.
@MainActor
final class VoiceCaptureLiveUITests: XCTestCase {
    func testFirstPermissionsThenRepeatedRealMicrophoneHolds() throws {
        guard ProcessInfo.processInfo.environment["IMPO_VOICE_HARDWARE_QA"] == "1" else {
            throw XCTSkip("Requires an isolated physical-device voice QA build")
        }
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "ai.impo.voiceqa")
        app.launchArguments = ["--reset-demo", "--show-main"]
        app.launch()
        let input = app.textViews["chat.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 15))
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let monitor = addUIInterruptionMonitor(withDescription: "Voice permissions") { alert in
            let allow = alert.buttons.matching(NSPredicate(format: "label IN %@", ["Allow", "OK", "允许", "好"])).firstMatch
            guard allow.exists else { return false }
            allow.tap()
            return true
        }
        defer { removeUIInterruptionMonitor(monitor) }

        // Fresh QA bundle exercises both first-use permission callbacks. Existing
        // authorization is also supported for repeat runs without resetting data.
        for _ in 0..<3 {
            input.press(forDuration: 1)
            for _ in 0..<2 {
                let alert = springboard.alerts.firstMatch
                if alert.waitForExistence(timeout: 2) {
                    let allow = alert.buttons.matching(NSPredicate(format: "label IN %@", ["Allow", "OK", "允许", "好"])).firstMatch
                    XCTAssertTrue(allow.exists, alert.debugDescription)
                    allow.tap()
                }
            }
            XCTAssertEqual(app.state, .runningForeground)
        }

        // Exercise the real audio tap repeatedly and cancellation cleanup.
        for fraction in [0.1, 0.5, 0.9] {
            let start = input.coordinate(withNormalizedOffset: CGVector(dx: fraction, dy: 0.5))
            start.press(forDuration: 4, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -180)))
            XCTAssertEqual(app.state, .runningForeground)
            XCTAssertFalse(app.descendants(matching: .any)["voice.preview"].exists)
            XCTAssertFalse(app.descendants(matching: .any)["chat.voice.transcribing"].exists)
        }
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Real microphone holds completed without crash"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
