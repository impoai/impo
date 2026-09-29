import XCTest

@MainActor final class EchoUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure=false }
    func testLargeLibraryAutomaticallyLoadsAndScrubsAcrossDaysAndMonths() async throws {
        var request=URLRequest(url:URL(string:"http://127.0.0.1:3009/api/v1/listening/segments?limit=100")!)
        request.setValue("Bearer instant-dev-alice",forHTTPHeaderField:"Authorization")
        let (data,response)=try await URLSession.shared.data(for:request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode,200)
        let latest=(try JSONSerialization.jsonObject(with:data) as! [String:Any])["segments"] as! [[String:Any]]
        let first=latest[0]["id"] as! String, sixty=latest[35]["id"] as! String
        let app=XCUIApplication();app.launchArguments=["--reset-demo","--show-main","--live-backend","http://127.0.0.1:3009","--permission-preview","allowed"]
        app.launch();XCTAssertTrue(app.buttons["tab.memories"].waitForExistence(timeout:10))
        if app.buttons["Not now"].waitForExistence(timeout:3) { app.buttons["Not now"].tap() }
        XCTAssertFalse(app.buttons["chat.transcripts"].exists, "Echo lives only in Memories");app.buttons["tab.memories"].tap()
        XCTAssertTrue(app.buttons["listening.recording.\(first)"].waitForExistence(timeout:10))
        let rail=app.descendants(matching:.any).matching(identifier:"echo.date-rail").firstMatch
        XCTAssertTrue(rail.waitForExistence(timeout:10));capture("Echo latest — 20000 record fixture",app)
        let timeline=app.collectionViews["echo.timeline"]
        for _ in 0..<18 {
            if app.buttons["listening.recording.\(sixty)"].isHittable { break }
            timeline.swipeUp()
        }
        XCTAssertTrue(app.buttons["listening.recording.\(sixty)"].exists,"Scrolling must load beyond the first page without tapping Show more")
        capture("Echo automatic pagination",app)
        XCTAssertEqual(app.buttons["echo.rail.granularity"].label, "Date navigation: days")
        let top=rail.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.03)),bottom=rail.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.995))
        top.press(forDuration:0.1,thenDragTo:bottom)
        let oldest=app.staticTexts.containing(NSPredicate(format:"label CONTAINS %@","[QA 19960]")).firstMatch
        XCTAssertTrue(oldest.waitForExistence(timeout:10),app.debugDescription)
        capture("Echo direct jump to oldest day",app)
        app.buttons["echo.latest"].tap()
        XCTAssertTrue(app.buttons["listening.recording.\(first)"].waitForExistence(timeout:10))
        app.buttons["echo.rail.granularity"].tap();app.buttons["By month"].tap()
        top.press(forDuration:0.1,thenDragTo:rail.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.5)))
        XCTAssertTrue(app.buttons["echo.latest"].waitForExistence(timeout:10))
        capture("Echo monthly date scrubber",app)
        app.buttons["listening.by-date"].tap()
        XCTAssertTrue(app.navigationBars["Find a day"].waitForExistence(timeout:5));capture("Echo calendar dates",app)
        app.buttons["Back to latest"].tap()
        XCTAssertTrue(app.buttons["listening.recording.\(first)"].waitForExistence(timeout:10))
        app.buttons["listening.recording.\(first)"].tap()
        XCTAssertTrue(app.staticTexts["listening.full-transcript"].waitForExistence(timeout:5))
        XCTAssertTrue(app.staticTexts["listening.full-transcript"].label.contains("[QA 00000]"))
        app.buttons["echo.detail-back"].tap();app.buttons["Done"].tap()
        app.buttons["tab.memories"].tap()
        XCTAssertTrue(app.buttons["listening.recording.\(first)"].waitForExistence(timeout:10))
        XCTAssertTrue(rail.exists);capture("Echo embedded in Memories",app)
    }
    func testSlowAndFailedBodiesKeepTheWholeTimelineScrollable() async throws {
        func control(_ delay: Int, failures: Int = 0) async throws {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:3010/__echo-fixture")!)
            request.httpMethod = "POST"
            request.httpBody = try JSONSerialization.data(withJSONObject: ["delayMs": delay, "failures": failures])
            let (_, response) = try await URLSession.shared.data(for: request)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        }
        try await control(5000)
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", "http://127.0.0.1:3010", "--permission-preview", "allowed"]
        app.launch()
        XCTAssertTrue(app.buttons["tab.memories"].waitForExistence(timeout: 10))
        if app.buttons["Not now"].waitForExistence(timeout: 2) { app.buttons["Not now"].tap() }
        app.buttons["tab.memories"].tap()
        let rail = app.descendants(matching: .any).matching(identifier: "echo.date-rail").firstMatch
        XCTAssertTrue(rail.waitForExistence(timeout: 5))
        let top = rail.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.03))
        let bottom = rail.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.995))
        top.press(forDuration: 0.1, thenDragTo: bottom)
        let placeholder = app.descendants(matching: .any).matching(identifier: "echo.recording-placeholder").firstMatch
        XCTAssertTrue(placeholder.waitForExistence(timeout: 2), "Oldest positions must exist before bodies arrive")
        let y = placeholder.frame.minY
        let oldest = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "[QA 19960]")).firstMatch
        XCTAssertTrue(oldest.waitForExistence(timeout: 10))
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "listening.recording.")).firstMatch
        XCTAssertEqual(row.frame.minY, y, accuracy: 2, "Hydrating a placeholder must preserve its position")
        capture("Echo oldest day hydrated in place", app)
        try await control(0, failures: 1)
        bottom.press(forDuration: 0.1, thenDragTo: rail.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)))
        let retry = app.buttons["echo.retry-recording"].firstMatch
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        XCTAssertTrue(rail.exists)
        retry.tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "listening.recording.")).firstMatch.waitForExistence(timeout: 5))
        // More than six old pages: cached text may be evicted, scroll slots must remain.
        let timeline = app.collectionViews["echo.timeline"]
        for _ in 0..<36 { timeline.swipeUp(velocity: .fast) }
        for _ in 0..<4 { timeline.swipeDown(velocity: .fast) }
        XCTAssertFalse(app.buttons["listening.load-more"].exists)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "listening.recording.")).firstMatch.waitForExistence(timeout: 5))
        app.buttons["echo.latest"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "[QA 00000]")).firstMatch.waitForExistence(timeout: 10))
        try await control(0)
    }
    func testLocationDetailsLabelsAndSettings() async throws {
        let app=XCUIApplication();app.launchArguments=["--reset-demo","--show-main","--live-backend","http://127.0.0.1:3009","--permission-preview","allowed"]
        app.launch();XCTAssertTrue(app.buttons["tab.memories"].waitForExistence(timeout:10))
        if app.buttons["Not now"].waitForExistence(timeout:2) { app.buttons["Not now"].tap() }
        app.buttons["tab.memories"].tap()
        let row=app.buttons.matching(NSPredicate(format:"identifier BEGINSWITH %@", "listening.recording.")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout:10));row.tap()
        XCTAssertTrue(app.buttons["echo.location.edit"].waitForExistence(timeout:5))
        XCTAssertTrue(app.staticTexts["Near Huangpu, Shanghai, China"].exists)
        XCTAssertTrue(app.staticTexts["Near Jing'an, Shanghai, China"].exists)
        capture("Echo multiple recording locations",app)
        app.buttons["echo.location.edit"].tap()
        XCTAssertTrue(app.textFields["echo.location.label"].waitForExistence(timeout:5))
        app.buttons["Office"].tap();app.buttons["echo.location.save"].tap()
        XCTAssertTrue(app.staticTexts["Your label"].waitForExistence(timeout:5))
        XCTAssertTrue(app.staticTexts["Near Huangpu, Shanghai, China"].exists)
        capture("Echo user label and device locations",app)
        app.buttons["echo.detail-back"].tap()
        app.buttons["echo.sync-options"].tap()
        XCTAssertTrue(app.switches["echo.location.enabled"].waitForExistence(timeout:5))
        app.switches["echo.location.enabled"].tap()
        capture("Echo optional location settings",app)
    }
    func testLocationConsentCanBeScrolledAndDeclined() {
        let app=XCUIApplication();app.launchArguments=["--reset-demo","--show-main","--live-backend","http://127.0.0.1:3009","--permission-preview","allowed"]
        app.launch();XCTAssertTrue(app.buttons["listening.toggle"].waitForExistence(timeout:10))
        if app.buttons["Not now"].waitForExistence(timeout:2) { app.buttons["Not now"].tap() }
        app.buttons["listening.toggle"].tap()
        XCTAssertTrue(app.switches["echo.location.enabled"].waitForExistence(timeout:5))
        for _ in 0..<5 where !app.buttons["listening.decline"].isHittable { app.swipeUp() }
        XCTAssertTrue(app.buttons["listening.agree"].isHittable)
        XCTAssertTrue(app.buttons["listening.decline"].isHittable)
        capture("Echo location consent on compact iPhone",app)
        app.buttons["listening.decline"].tap()
        XCTAssertFalse(app.buttons["listening.stop"].exists)
    }
    private func capture(_ name:String,_ app:XCUIApplication) {
        let a=XCTAttachment(screenshot:app.screenshot());a.name=name;a.lifetime = .keepAlways;add(a)
    }
}
