import XCTest

@MainActor final class EchoSpeakerUITests: XCTestCase {
    func testChoosingExcludingAndRevokingYourVoicePersistsAcrossRelaunch() async throws {
        continueAfterFailure = false
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3018/api/v1/listening/segments?limit=1")!)
        request.setValue("Bearer instant-dev-alice", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: request)
        let record = ((try JSONSerialization.jsonObject(with: data) as! [String: Any])["segments"] as! [[String: Any]])[0]
        request.url = URL(string: "http://127.0.0.1:3018/api/v1/listening/segments/\(record["id"] as! String)/speakers")!
        request.httpMethod = "PATCH"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["revision": (record["speakerReview"] as! [String: Any])["revision"]!, "status": "unconfirmed", "selfSpeakerIds": [], "excludedUtteranceIds": []])
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", "http://127.0.0.1:3018", "--permission-preview", "allowed"]
        app.launch(); openFirstEcho(app)
        app.buttons["echo.speakers.edit"].tap()
        XCTAssertTrue(app.buttons["echo.speakers.option.0"].waitForExistence(timeout: 10))
        let choices = XCTAttachment(screenshot: app.screenshot()); choices.name = "Echo speaker choices"; choices.lifetime = .keepAlways; add(choices)
        app.buttons["echo.speakers.option.0"].tap()
        app.buttons["echo.speakers.save"].tap()
        XCTAssertTrue(app.staticTexts["Your voice is selected"].waitForExistence(timeout: 10))
        let toggle = app.buttons["echo.speakers.u1.toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10), app.debugDescription); toggle.tap()
        XCTAssertTrue(app.staticTexts["Excluded from memories and Brief"].waitForExistence(timeout: 10))
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "Echo speaker confirmation"; shot.lifetime = .keepAlways; add(shot)
        app.terminate()
        app.launchArguments = ["--show-main", "--live-backend", "http://127.0.0.1:3018", "--permission-preview", "allowed"]
        app.launch(); openFirstEcho(app)
        XCTAssertTrue(app.staticTexts["Your voice is selected"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Excluded from memories and Brief"].waitForExistence(timeout: 10))
        app.buttons["echo.speakers.edit"].tap()
        let unknown = app.buttons["echo.speakers.unknown"]
        for _ in 0..<4 where !unknown.isHittable { app.swipeUp() }
        unknown.tap(); app.buttons["echo.speakers.save"].tap()
        XCTAssertTrue(app.staticTexts["Which voice is yours?"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["echo.speakers.u1.toggle"].exists)
        app.buttons["echo.speakers.edit"].tap()
        let none = app.buttons["echo.speakers.none"]
        for _ in 0..<4 where !none.isHittable { app.swipeUp() }
        none.tap(); app.buttons["echo.speakers.save"].tap()
        XCTAssertTrue(app.staticTexts["You are not in this recording"].waitForExistence(timeout: 10))
    }
    private func openFirstEcho(_ app: XCUIApplication) {
        XCTAssertTrue(app.buttons["tab.memories"].waitForExistence(timeout: 20))
        if app.buttons["Not now"].waitForExistence(timeout: 2) { app.buttons["Not now"].tap() }
        app.buttons["tab.memories"].tap()
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "listening.recording.")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
        XCTAssertTrue(app.buttons["echo.speakers.edit"].waitForExistence(timeout: 10))
    }
}
