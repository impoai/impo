import XCTest

@MainActor
final class VoiceComposerUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = false
        app.launchArguments = ["--reset-demo", "--show-main", "--voice-fixture", "Voice gesture regression"]
        app.launch()
        XCTAssertTrue(app.textViews["chat.input"].waitForExistence(timeout: 10))
    }

    func testHoldingLeftMiddleAndRightOfComposerSendsOnce() {
        for fraction in [0.08, 0.5, 0.92] {
            let before = messages.count
            let input = app.textViews["chat.input"]
            input.coordinate(withNormalizedOffset: CGVector(dx: fraction, dy: 0.5)).press(forDuration: 0.9)
            XCTAssertTrue(element("chat.voice.transcribing").waitForExistence(timeout: 2))
            let sent = XCTNSPredicateExpectation(predicate: NSPredicate(format: "count == %d", before + 1), object: messages)
            XCTAssertEqual(XCTWaiter.wait(for: [sent], timeout: 6), .completed)
            waitUntilGone("chat.thinking")
            XCTAssertEqual(messages.count, before + 1)
        }
        // The indicator remains part of the same hold target.
        element("chat.voice").press(forDuration: 0.9)
        XCTAssertTrue(element("chat.voice.transcribing").waitForExistence(timeout: 2))
    }

    func testSlideUpCancelsFromMiddleOfInput() {
        let start = app.textViews["chat.input"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.8, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -180)))
        XCTAssertFalse(element("chat.voice.transcribing").waitForExistence(timeout: 2))
        XCTAssertEqual(messages.count, 0)
        XCTAssertFalse(element("voice.preview").exists)
        XCTAssertFalse(app.keyboards.firstMatch.exists)
    }

    func testTapTypesAndLongPressPreservesDraft() {
        let input = app.textViews["chat.input"]
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        XCTAssertFalse(element("voice.preview").exists)
        input.typeText("Keep this draft")
        input.press(forDuration: 0.9)
        XCTAssertEqual(input.value as? String, "Keep this draft")
        XCTAssertFalse(element("voice.preview").exists)
        XCTAssertEqual(messages.count, 0)
        element("chat.send").tap()
        XCTAssertTrue(app.staticTexts["Keep this draft"].waitForExistence(timeout: 3))
    }

    private var messages: XCUIElementQuery { app.descendants(matching: .any).matching(identifier: "chat.message.user") }
    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    private func waitUntilGone(_ id: String) {
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element(id))
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 8), .completed)
    }
}
