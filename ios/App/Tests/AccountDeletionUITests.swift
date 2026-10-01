import XCTest

@MainActor final class AccountDeletionUITests: XCTestCase {
    func testDeletionRequiresBothWarningAndExactConfirmation() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", "http://127.0.0.1:3016", "--account-deletion-fixture"]
        app.launch()
        let first = app.buttons["account-deletion.continue"]
        XCTAssertTrue(first.waitForExistence(timeout: 20)); XCTAssertTrue(first.isEnabled)
        XCTAssertFalse(app.buttons["account-deletion.delete"].exists)
        first.tap()
        let confirmation = app.textFields["account-deletion.confirmation"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 10))
        let final = app.buttons["account-deletion.delete"]
        XCTAssertFalse(final.isEnabled)
        confirmation.tap(); confirmation.typeText("DELET")
        XCTAssertFalse(final.isEnabled)
        confirmation.typeText("E"); XCTAssertTrue(final.isEnabled)
        final.tap()
        XCTAssertTrue(app.staticTexts["Your account is closed."].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Check deletion status"].exists)
    }
}
