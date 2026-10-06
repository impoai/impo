import XCTest

/// Run the synthetic fixture: node --import tsx scripts/android-ui-fixture.ts --port 3019 --long-history 240
///
/// The fixture logs one `fixture.conversation` line per history request. A cold
/// start should read one `beforeSequence` page, a relaunch one `afterSequence`
/// page from the newest stored message, and scrolling up one `beforeSequence`
/// page per 50 older messages.
@MainActor final class ConversationHistoryUITests: XCTestCase {
    func testTheChatOpensOnTheNewestPageAndLoadsOlderOnesWhileScrollingUp() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", "http://127.0.0.1:3019", "--permission-preview", "allowed"]
        app.launch()
        if app.buttons["Not now"].waitForExistence(timeout: 2) { app.buttons["Not now"].tap() }
        let newest = app.staticTexts["Help me make room for a good day."]
        XCTAssertTrue(newest.waitForExistence(timeout: 20), app.debugDescription)
        // 242 messages exist; only the newest page is loaded.
        XCTAssertFalse(app.staticTexts["Question 1 of the long history"].exists)
        XCTAssertFalse(app.staticTexts["Question 101 of the long history"].exists)
        capture("Newest page on a cold start", app)

        // Reaching the top loads the page before it, until the first message appears.
        let first = app.staticTexts["Question 1 of the long history"]
        for _ in 0..<40 where !first.exists {
            app.swipeDown(velocity: .fast)
        }
        XCTAssertTrue(first.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Answer 2 of the long history"].exists)
        XCTAssertFalse(app.otherElements["chat.loadingOlder"].exists, "nothing older remains")
        capture("First message after scrolling up", app)

        // A relaunch shows the stored tail at once and asks the server only for newer messages.
        app.terminate()
        app.launchArguments = ["--show-main", "--live-backend", "http://127.0.0.1:3019", "--permission-preview", "allowed"]
        app.launch()
        XCTAssertTrue(newest.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertFalse(app.staticTexts["Question 1 of the long history"].exists)
        capture("Stored tail after relaunch", app)
    }

    private func capture(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
