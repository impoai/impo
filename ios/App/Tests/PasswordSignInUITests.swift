import XCTest

@MainActor
final class PasswordSignInUITests: XCTestCase {
    private let app = XCUIApplication()

    func testEmailFormResetNavigationAndCancel() {
        openEmail()
        XCTAssertFalse(element("auth.submit").isEnabled)
        element("auth.email").tap()
        element("auth.email").typeText("someone@example.com")
        element("auth.password").tap()
        element("auth.password").typeText("temporary input")
        XCTAssertTrue(element("auth.submit").isEnabled)
        element("auth.forgot").tap()
        XCTAssertTrue(app.staticTexts["Reset your password"].waitForExistence(timeout: 5))
        XCTAssertFalse(element("auth.password").exists)
        XCTAssertTrue(element("auth.submit").isEnabled)
        app.buttons["Back to sign in"].tap()
        XCTAssertTrue(element("auth.password").waitForExistence(timeout: 5))
        XCTAssertFalse(element("auth.submit").isEnabled, "Returning to sign-in clears the password")
        capture("Email password form")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(element("onboarding.login.email").waitForExistence(timeout: 5))
        XCTAssertTrue(element("onboarding.login.apple").exists)
        XCTAssertTrue(element("onboarding.login").exists)
    }

    /// Opt in with a disposable Clerk development user. Never use a personal account.
    /// The local JSON contains email/password and is not part of the app or repository.
    func testLiveDevelopmentPasswordLogin() throws {
        let path = "/tmp/impo-password-auth-test.json"
        guard FileManager.default.fileExists(atPath: path) else { throw XCTSkip("Requires disposable Clerk development credentials") }
        let credentials = try JSONDecoder().decode(Credentials.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        openEmail()
        element("auth.email").tap(); element("auth.email").typeText(credentials.email)
        element("auth.password").tap(); element("auth.password").typeText("deliberately-wrong-password")
        element("auth.submit").tap()
        XCTAssertTrue(element("auth.error").waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts["AI Data Processing Notice"].exists)
        element("auth.password").tap(); element("auth.password").typeText(credentials.password)
        element("auth.submit").tap()
        let code = element("auth.code")
        if code.waitForExistence(timeout: 8) {
            code.tap(); code.typeText("424242")
            element("auth.submit").tap()
        }
        XCTAssertTrue(app.staticTexts["AI Data Processing Notice"].waitForExistence(timeout: 20), "The authenticated account reaches the existing consent flow")
        capture("Password login reaches account consent")
    }

    private struct Credentials: Decodable { let email: String; let password: String }
    private func openEmail() {
        continueAfterFailure = false
        app.launchArguments = ["--reset-demo", "--onboarding-step", "1"]
        app.launch()
        XCTAssertTrue(element("onboarding.login.email").waitForExistence(timeout: 15))
        element("onboarding.login.email").tap()
        XCTAssertTrue(element("auth.email").waitForExistence(timeout: 5))
    }
    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
