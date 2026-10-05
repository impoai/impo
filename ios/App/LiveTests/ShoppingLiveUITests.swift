import XCTest

/// Opt-in production coverage with a disposable account created for this test run.
@MainActor final class ShoppingLiveUITests: XCTestCase {
    private let app = XCUIApplication()
    private struct Credentials: Decodable { let email: String; let password: String }
    func testLiveSearchDetailsAndHistory() throws {
        let path = "/tmp/impo-shopping-live.json"
        guard FileManager.default.fileExists(atPath: path) else { throw XCTSkip("Requires disposable catalog test credentials") }
        let credentials = try JSONDecoder().decode(Credentials.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        guard credentials.email.hasPrefix("commerce-test-") else { throw XCTSkip("Use a disposable catalog test account") }
        continueAfterFailure = false
        app.launch()
        if element("onboarding.begin").waitForExistence(timeout: 5) { tap("onboarding.begin") }
        if element("onboarding.login.email").waitForExistence(timeout: 5) {
            tap("onboarding.login.email")
            tap("auth.email"); element("auth.email").typeText(credentials.email)
            tap("auth.password"); element("auth.password").typeText(credentials.password)
            tap("auth.submit")
        }
        if element("onboarding.agree").waitForExistence(timeout: 15) {
            tap("onboarding.agree"); tap("onboarding.connections.skip"); tap("onboarding.intro.continue")
            tap("onboarding.name.field"); element("onboarding.name.field").typeText("Catalog Tester")
            tap("onboarding.name.continue"); tap("onboarding.avatar.continue")
        }
        if app.buttons["Not now"].waitForExistence(timeout: 5) { app.buttons["Not now"].tap() }
        tap("chat.input")
        if app.buttons["Not now"].waitForExistence(timeout: 3) { app.buttons["Not now"].tap(); tap("chat.input") }
        element("chat.input").typeText("Find commuter backpacks under USD 150 that ship to the US. Search the Shopify catalog in English and show product cards. Keep the answer to one sentence.")
        tap("chat.send")
        let thinking = element("chat.thinking")
        if thinking.waitForExistence(timeout: 10) {
            let finished = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: thinking)
            XCTAssertEqual(XCTWaiter.wait(for: [finished], timeout: 180), .completed)
        }
        let groups = app.otherElements.matching(identifier: "shopping.results")
        XCTAssertTrue(groups.firstMatch.waitForExistence(timeout: 30))
        let latest = groups.element(boundBy: groups.count - 1)
        let card = latest.buttons.matching(identifier: "shopping.product").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 30))
        Thread.sleep(forTimeInterval: 2)
        XCTAssertLessThan(card.frame.maxY, element("chat.input").frame.minY, "Product prices must be visible above the composer")
        XCTAssertTrue(card.label.contains("USD"))
        capture("Live catalog search")
        card.tap()
        XCTAssertTrue(element("shopping.openStore").waitForExistence(timeout: 30))
        XCTAssertTrue(app.navigationBars["Product details"].exists)
        capture("Live product details")
        app.buttons["Done"].tap()
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons.matching(identifier: "shopping.product").firstMatch.waitForExistence(timeout: 60), "Product references survive app restart and history reload")
        XCTAssertTrue(app.buttons.matching(identifier: "shopping.product").firstMatch.label.contains("USD"))
        capture("Live catalog restored from history")
    }
    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    private func tap(_ id: String) {
        let e = element(id); XCTAssertTrue(e.waitForExistence(timeout: 30), "Missing \(id)")
        for _ in 0..<6 { if e.isHittable { e.tap(); return }; app.swipeUp() }
        XCTFail("Control not hittable: \(id)")
    }
    private func capture(_ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
}
