import XCTest

@MainActor
final class ListeningUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }
    func testDebugLogsVisibleAndExportable() {
        let app = XCUIApplication(); app.launchArguments = ["--reset-demo","--show-main","--debug-mode"]
        app.launch()
        XCTAssertTrue(app.buttons["chat.settings"].waitForExistence(timeout:10));app.buttons["chat.settings"].tap()
        let debug = app.buttons["settings.listening-debug"]
        for _ in 0..<4 where !debug.isHittable { app.swipeUp() }
        debug.tap()
        XCTAssertTrue(app.staticTexts["listening.debug-status"].waitForExistence(timeout:5))
        XCTAssertTrue(app.staticTexts["listening.debug-logs"].label.contains("app.launch"))
        app.buttons["listening.debug-export"].tap()
        XCTAssertTrue(app.buttons["listening.debug-share"].waitForExistence(timeout:5))
        let image = XCTAttachment(screenshot:app.screenshot());image.name="Listening Debug and export";image.lifetime = .keepAlways;add(image)
    }

    func testTimelineNavigationAndOfflineRecordingNotice() {
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main"]
        app.launch()
        XCTAssertTrue(app.buttons["listening.toggle"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["tab.assistant"].exists)
        app.buttons["listening.toggle"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Sign in or connect")).firstMatch.waitForExistence(timeout: 5))
        app.buttons["tab.memories"].tap()
        XCTAssertTrue(app.staticTexts["Your words, kept in order."].waitForExistence(timeout: 5))
        app.buttons["listening.by-date"].tap()
        XCTAssertTrue(app.navigationBars["Find a day"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Back to latest"].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Listening timeline"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.buttons["Done"].tap()
        app.buttons["tab.chat"].tap(); app.buttons["chat.assistant"].tap()
        XCTAssertTrue(app.buttons["assistant.editName"].waitForExistence(timeout: 5))
    }

    func testTranscribedRecordingAppearsOnTimelineAndCanBeDeleted() async throws {
        guard let backend = ProcessInfo.processInfo.environment["IMPO_UI_LIVE_BACKEND"] else { throw XCTSkip("Requires the local development API") }
        let base = URL(string: backend)!.appendingPathComponent("api/v1/listening/segments")
        var request = URLRequest(url: base)
        request.httpMethod = "POST"
        request.setValue("Bearer instant-dev-alice", forHTTPHeaderField: "Authorization")
        request.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        request.setValue(UUID().uuidString, forHTTPHeaderField: "X-Client-Segment-Id")
        let date = ISO8601DateFormatter()
        // Yesterday must appear without manually selecting yesterday in a calendar.
        request.setValue(date.string(from: Date().addingTimeInterval(-86405)), forHTTPHeaderField: "X-Recording-Started-At")
        request.setValue(date.string(from: Date().addingTimeInterval(-86400)), forHTTPHeaderField: "X-Recording-Ended-At")
        let audio = Data("UI fixture \(UUID().uuidString)".utf8)
        request.httpBody = audio
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 202)
        let receipt = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let id = try XCTUnwrap(receipt["id"] as? String)
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", backend]
        app.launch()
        XCTAssertTrue(app.buttons["tab.memories"].waitForExistence(timeout: 10))
        app.buttons["tab.memories"].tap()
        let transcript = app.staticTexts["Development transcript for \(audio.count) bytes of audio."]
        XCTAssertTrue(transcript.waitForExistence(timeout: 15))
        let image = XCTAttachment(screenshot: app.screenshot()); image.name = "Transcribed recording timeline"; image.lifetime = .keepAlways; add(image)
        app.buttons["listening.recording.\(id)"].tap()
        XCTAssertTrue(app.staticTexts["listening.full-transcript"].waitForExistence(timeout: 5))
        app.buttons["listening.delete"].tap()
        app.sheets.buttons["Delete recording"].firstMatch.tap()
        XCTAssertTrue(app.buttons["listening.recording.\(id)"].waitForNonExistence(timeout: 8))
    }

    func testRecordingStatusStaysAtTopAcrossTabsAndOpensTranscripts() {
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--preview-listening-activity"]
        app.launch()
        let stop = app.buttons["listening.stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["listening.open-transcripts"].value as? String, "Speech detected")
        XCTAssertFalse(app.staticTexts["Speech detected"].exists, "The visual status is the dot matrix; speech state remains accessible")
        XCTAssertLessThan(stop.frame.midY, app.frame.height * 0.25)
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Top listening status (UI fixture, microphone off)"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.buttons["tab.tasks"].tap()
        XCTAssertTrue(stop.exists)
        XCTAssertLessThan(stop.frame.midY, app.frame.height * 0.25)
        app.buttons["listening.open-transcripts"].tap()
        XCTAssertTrue(app.staticTexts["Your days, in echoes."].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        stop.tap()
        XCTAssertFalse(stop.exists)
    }

    func testQuietEchoKeepsAnHonestIdleMatrix() {
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--preview-listening-activity", "--preview-echo-quiet"]
        app.launch()
        XCTAssertTrue(app.buttons["listening.stop"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["listening.open-transcripts"].value as? String, "Waiting for speech")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "Echo quiet matrix (microphone off fixture)"; shot.lifetime = .keepAlways; add(shot)
        app.buttons["listening.stop"].tap()
    }

    func testPausedListeningKeepsStatusAndStopAcrossTabs() {
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--preview-listening-activity", "--preview-listening-paused"]
        app.launch()
        let stop = app.buttons["listening.stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Echo paused"].exists)
        XCTAssertTrue(app.buttons["listening.resume"].exists)
        XCTAssertEqual(app.buttons["listening.toggle"].label, "Stop Echo recording")
        app.buttons["tab.tasks"].tap()
        XCTAssertTrue(stop.exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Interrupted listening retains session (microphone off fixture)"
        screenshot.lifetime = .keepAlways; add(screenshot)
        stop.tap()
        XCTAssertFalse(stop.exists)
        XCTAssertEqual(app.buttons["listening.toggle"].label, "Start Echo recording")
    }

    func testPausedLiveActivityKeepsStopOnSystemSurface() {
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--preview-listening-activity", "--preview-listening-paused"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Echo paused"].waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.01))
        let bottom = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.75))
        top.press(forDuration: 0.1, thenDragTo: bottom)
        if springboard.buttons["Always Allow"].waitForExistence(timeout: 1) { springboard.buttons["Always Allow"].tap() }
        else if springboard.buttons["Allow"].waitForExistence(timeout: 1) { springboard.buttons["Allow"].tap() }
        XCTAssertTrue(springboard.staticTexts["Echo paused"].waitForExistence(timeout: 8))
        let shot = XCTAttachment(screenshot: springboard.screenshot()); shot.name = "Paused Live Activity (microphone off fixture)"; shot.lifetime = .keepAlways; add(shot)
        springboard.buttons["Stop Echo recording"].firstMatch.tap()
        app.activate()
        XCTAssertFalse(app.buttons["listening.stop"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.buttons["listening.toggle"].label, "Start Echo recording")
    }

    func testLiveActivityStopFromSystemSurface() {
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--preview-listening-activity"]
        app.launch()
        XCTAssertTrue(app.buttons["listening.stop"].waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.01))
        let bottom = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.75))
        top.press(forDuration: 0.1, thenDragTo: bottom)
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 2) { allow.tap() }
        let shot = XCTAttachment(screenshot: springboard.screenshot()); shot.name = "System Live Activity (UI fixture, microphone off)"; shot.lifetime = .keepAlways; add(shot)
        let tree = XCTAttachment(string: springboard.debugDescription); tree.name = "Live Activity accessibility"; tree.lifetime = .keepAlways; add(tree)
        let stop = springboard.buttons["Stop Echo recording"].firstMatch
        XCTAssertTrue(stop.waitForExistence(timeout: 8))
        stop.tap()
        app.activate()
        XCTAssertFalse(app.buttons["listening.stop"].waitForExistence(timeout: 3))
    }

}
