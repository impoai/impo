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
        let select = app.buttons["Select Full Response"]
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

    func testHeadingSelectsInPlaceWithoutMovingSurroundingContent() {
        let heading = app.staticTexts["对数求导"].firstMatch
        XCTAssertTrue(heading.waitForExistence(timeout: 10))
        sleep(2)
        let original = heading.frame
        let tableFrame = element("response.table").frame
        heading.press(forDuration: 0.8)
        app.buttons["Select Text"].tap()
        let text = app.textViews["response.selection.inline"]
        XCTAssertTrue(text.waitForExistence(timeout: 4))
        XCTAssertEqual(text.value as? String, "对数求导")
        XCTAssertFalse(app.textViews["response.selection.text"].exists)
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        XCTAssertEqual(text.frame.minY, original.minY, accuracy: 3)
        XCTAssertEqual(element("response.table").frame.minY, tableFrame.minY, accuracy: 3)
        XCTAssertTrue(app.menuItems["Copy"].waitForExistence(timeout: 4))
        capture("In-place heading selection with formatting preserved")
        let done = app.menuItems["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 3))
        done.tap()
        XCTAssertTrue(heading.waitForExistence(timeout: 3))
        XCTAssertFalse(text.exists)
    }

    func testInPlaceSelectionFreezesTheReplyWhileStreaming() {
        app.buttons["Streaming"].tap()
        element("response.fixture.stream").tap()
        let paragraph = app.staticTexts["First paragraph is ready for selection."]
        XCTAssertTrue(paragraph.waitForExistence(timeout: 4))
        let original = paragraph.frame
        paragraph.press(forDuration: 0.8)
        app.buttons["Select Text"].tap()
        let text = app.textViews["response.selection.inline"]
        XCTAssertTrue(text.waitForExistence(timeout: 4))
        sleep(9)
        XCTAssertEqual(text.value as? String, "First paragraph is ready for selection.")
        XCTAssertEqual(text.frame.minY, original.minY, accuracy: 3)
        capture("In-place selection stays fixed while the reply streams")
        app.menuItems["Done"].tap()
        XCTAssertTrue(app.staticTexts["The response is complete."].waitForExistence(timeout: 4))
    }

    func testWrappedParagraphAndListKeepTheirLayoutDuringSelection() {
        let scroll = app.scrollViews["response.fixture.scroll"]
        XCTAssertTrue(app.staticTexts["对数求导"].waitForExistence(timeout: 10))
        sleep(2)
        scroll.swipeUp()
        let paragraph = app.staticTexts["This method also helps with products and quotients."]
        XCTAssertTrue(paragraph.isHittable)
        let original = paragraph.frame
        let nextBlock = app.buttons["Copy code"].frame
        paragraph.press(forDuration: 0.8)
        app.buttons["Select Text"].tap()
        let text = app.textViews["response.selection.inline"]
        XCTAssertTrue(text.waitForExistence(timeout: 4))
        XCTAssertEqual(text.frame.minY, original.minY, accuracy: 3)
        XCTAssertEqual(text.frame.height, original.height, accuracy: 3)
        XCTAssertEqual(app.buttons["Copy code"].frame.minY, nextBlock.minY, accuracy: 3)
        XCTAssertTrue(app.menuItems["Done"].waitForExistence(timeout: 4))
        capture("Wrapped paragraph selection preserves surrounding blocks")
        app.menuItems["Done"].tap()

        let item = app.staticTexts["Multiply by the original function."]
        let itemFrame = item.frame
        let markers = app.staticTexts.matching(identifier: "•").allElementsBoundByIndex
        let marker = markers.min { abs($0.frame.minY - itemFrame.minY) < abs($1.frame.minY - itemFrame.minY) }!
        let markerFrame = marker.frame
        item.press(forDuration: 0.8)
        app.buttons["Select Text"].tap()
        XCTAssertTrue(text.waitForExistence(timeout: 4))
        XCTAssertEqual(text.frame.minY, itemFrame.minY, accuracy: 3)
        XCTAssertEqual(marker.frame.minY, markerFrame.minY, accuracy: 3)
        XCTAssertEqual(paragraph.frame.minY, original.minY, accuracy: 3)
        XCTAssertTrue(app.menuItems["Done"].waitForExistence(timeout: 4))
        capture("List item selection preserves indentation and baseline")
        app.menuItems["Done"].tap()
        XCTAssertTrue(item.waitForExistence(timeout: 3))
    }

    func testSelectionSnapshotSurvivesStreamingAndKeepsCompleteFinalBlocks() {
        app.buttons["Streaming"].tap()
        element("response.fixture.stream").tap()
        let paragraph = app.staticTexts["First paragraph is ready for selection."]
        XCTAssertTrue(paragraph.waitForExistence(timeout: 4))
        paragraph.press(forDuration: 0.8)
        app.buttons["Select Full Response"].tap()
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
        app.buttons["Select Full Response"].tap()
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
        // Chat gives every descendant the bubble's accessibility identifier.
        let inline = app.textViews["chat.message.assistant"].firstMatch
        XCTAssertTrue(inline.waitForExistence(timeout: 4))
        XCTAssertEqual(inline.value as? String, "Hey! How's your day going?")
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        XCTAssertTrue(app.menuItems["Done"].waitForExistence(timeout: 4))
        capture("In-place selection in the main chat")
        app.menuItems["Done"].tap()
        XCTAssertTrue(reply.waitForExistence(timeout: 3))
        reply.press(forDuration: 0.8)
        app.buttons["Select Full Response"].tap()
        XCTAssertTrue(app.textViews["response.selection.text"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textViews["response.selection.text"].value as? String, "Hey! How's your day going?")
    }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
