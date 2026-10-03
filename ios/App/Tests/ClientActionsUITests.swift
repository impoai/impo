import XCTest

@MainActor final class ClientActionsUITests: XCTestCase {
    func testOnlyTapsOpenLinksAndRestoringCardsDoesNotExecuteThem() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--client-actions-fixture"]
        app.launch()
        let link = app.buttons["message.action.impo_open_link"]
        XCTAssertTrue(link.waitForExistence(timeout: 15))
        XCTAssertEqual(app.staticTexts["actions.fixture.count"].label, "Opened: 0")
        link.tap()
        XCTAssertEqual(app.staticTexts["actions.fixture.count"].label, "Opened: 1")
        XCTAssertEqual(app.staticTexts["actions.fixture.destination"].label, "youtu.be")
        app.buttons["actions.fixture.restore"].tap()
        XCTAssertEqual(app.staticTexts["actions.fixture.count"].label, "Opened: 1")
        app.buttons["message.action.impo_navigate"].tap()
        XCTAssertEqual(app.staticTexts["actions.fixture.count"].label, "Opened: 2")
        XCTAssertEqual(app.staticTexts["actions.fixture.destination"].label, "maps.apple.com")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Client action cards"; screenshot.lifetime = .keepAlways; add(screenshot)
    }
}
