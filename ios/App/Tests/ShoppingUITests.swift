import XCTest

@MainActor final class ShoppingUITests: XCTestCase {
    func testProductCardsShowPricesAndOpenTheSelectedProduct() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--shopping-fixture"]
        app.launch()
        let first = app.buttons.matching(identifier: "shopping.product").firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 15))
        XCTAssertTrue(first.label.contains("USD 89.00"))
        first.tap()
        XCTAssertTrue(app.navigationBars["Product details"].waitForExistence(timeout: 5))
        let store = app.buttons["shopping.openStore"]
        XCTAssertTrue(store.waitForExistence(timeout: 5))
        XCTAssertTrue(store.isHittable, "The store action stays visible without scrolling through the description")
        XCTAssertTrue(store.label.contains("Example Outdoor"))
        let compact = XCTAttachment(screenshot: app.screenshot())
        compact.name = "Product details with visible store action"; compact.lifetime = .keepAlways; add(compact)
        let description = app.buttons["shopping.description.toggle"]
        for _ in 0..<4 where !description.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(description.isHittable)
        description.tap()
        XCTAssertEqual(description.label, "Show less")
        XCTAssertTrue(store.isHittable, "The store action remains visible with the full description expanded")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "Expanded product description and store action"; shot.lifetime = .keepAlways; add(shot)
    }
}
