import XCTest

@MainActor final class ResponseRenderingUITests: XCTestCase {
    private let app = XCUIApplication()
    override func setUpWithError() throws {
        continueAfterFailure = false
        app.launchArguments = ["--reset-demo", "--response-render-fixture"]
        app.launch()
    }

    func testRichResponseAndNativeSelection() {
        let heading = app.staticTexts["对数求导"].firstMatch
        XCTAssertTrue(heading.waitForExistence(timeout: 10))
        XCTAssertTrue(element("response.math").waitForExistence(timeout: 10))
        XCTAssertTrue(element("response.table").exists)
        sleep(2) // let the offline math renderer finish its first cold render
        capture("Rich Markdown, Chinese and mathematics")

        heading.press(forDuration: 0.8)
        let select = app.buttons["Select Text"]
        XCTAssertTrue(select.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Copy"].exists)
        capture("Long press response menu")
        select.tap()
        let text = app.textViews["response.selection.text"]
        XCTAssertTrue(text.waitForExistence(timeout: 5))
        XCTAssertTrue((text.value as? String)?.contains(#"\frac{y'}{y}=\ln x+1"#) == true)
        XCTAssertTrue((text.value as? String)?.contains("Function\tDerivative\tDescription") == true)
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        capture("Native range selection across the complete response")

        // The initial native word selection exposes UIKit Copy. The whole
        // answer is in this selector, so handles can move across block boundaries.
        let copy = app.menuItems["Copy"].firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 4))
        capture("Native Copy menu and selection handles")
        element("response.selection.done").tap()
        XCTAssertTrue(heading.waitForExistence(timeout: 3))

        let scroll = app.scrollViews["response.fixture.scroll"]
        scroll.swipeUp()
        XCTAssertTrue(app.buttons["Copy code"].waitForExistence(timeout: 3))
        capture("Lists, quote and scrollable code")
    }

    func testSelectionSnapshotSurvivesStreamingAndKeepsCompleteFinalBlocks() {
        app.buttons["Streaming"].tap()
        element("response.fixture.stream").tap()
        let paragraph = app.staticTexts["First paragraph is ready for selection."]
        XCTAssertTrue(paragraph.waitForExistence(timeout: 4))
        paragraph.press(forDuration: 0.8)
        app.buttons["Select Text"].tap()
        let text = app.textViews["response.selection.text"]
        XCTAssertTrue(text.waitForExistence(timeout: 5))
        let snapshot = text.value as? String
        sleep(9)
        XCTAssertEqual(text.value as? String, snapshot)
        XCTAssertFalse(snapshot?.contains("The response is complete.") == true)
        element("response.selection.done").tap()
        XCTAssertTrue(app.staticTexts["The response is complete."].waitForExistence(timeout: 4))
        XCTAssertTrue(element("response.math").exists)
        XCTAssertTrue(element("response.table").exists)
        capture("Completed streaming formula and table")
    }

    func testLongConversationScrollAndMainChatMenu() {
        app.buttons["Long chat"].tap()
        XCTAssertTrue(app.staticTexts["Answer 1"].waitForExistence(timeout: 5))
        element("response.fixture.latest").tap()
        let last = app.staticTexts["End of answer 100."]
        XCTAssertTrue(last.waitForExistence(timeout: 6))
        last.press(forDuration: 0.8)
        app.buttons["Select Text"].tap()
        let text = app.textViews["response.selection.text"]
        XCTAssertTrue(text.waitForExistence(timeout: 5))
        XCTAssertTrue((text.value as? String)?.hasPrefix("Answer 100") == true)
        element("response.selection.done").tap()
        XCTAssertTrue(last.isHittable)

        // Also exercise the same component inside the actual Chat bubble.
        app.terminate()
        app.launchArguments = ["--reset-demo", "--show-main"]
        app.launch()
        let input = element("chat.input")
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap(); input.typeText("Hello")
        element("chat.send").tap()
        let reply = app.staticTexts["Hey! How's your day going?"].firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 6))
        reply.press(forDuration: 0.8)
        app.buttons["Select Text"].tap()
        XCTAssertTrue(app.textViews["response.selection.text"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textViews["response.selection.text"].value as? String, "Hey! How's your day going?")
    }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
