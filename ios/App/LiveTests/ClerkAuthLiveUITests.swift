import XCTest

/// Opt-in real authentication tests. Configure your own Clerk instance and backend.
/// Mint a short-lived sign-in ticket for a test user through the Clerk Backend API
/// and place it at /tmp/instant_sign_in_ticket.txt before each run. Tickets are
/// single-use; do not commit them. Debug uses a local Clerk-auth API on port 3002;
/// Release uses the API URL supplied through Config.local.xcconfig.
@MainActor
final class ClerkAuthLiveUITests: XCTestCase {
    private let app = XCUIApplication()

    /// Debug builds use the Dev Clerk instance (see ClerkConfig), whose
    /// tokens only verify against a locally-run server in clerk auth mode
    /// with matching Dev keys - not the deployed production server.
    func testDevSignInAndRealReply() throws {
        let ticket = try readTicket()
        continueAfterFailure = false
        app.launchArguments = ["--reset-demo", "--sign-in-ticket", ticket, "--live-backend", "http://127.0.0.1:3002"]
        app.launch()
        sendAndExpectRealReply()
    }

    /// Release builds use the Production Clerk instance, which
    /// didSignIn() pairs automatically with the deployed production backend.
    func testProductionSignInAndRealReply() throws {
        let ticket = try readTicket()
        continueAfterFailure = false
        app.launchArguments = ["--reset-demo", "--sign-in-ticket", ticket]
        app.launch()
        sendAndExpectRealReply()
    }

    private func readTicket() throws -> String {
        try String(contentsOfFile: "/tmp/instant_sign_in_ticket.txt", encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func sendAndExpectRealReply() {
        let input = require("chat.input")
        input.tap(); input.typeText("Reply with exactly: LIVE_TEST_OK")
        let idle = NSPredicate(format: "enabled == true")
        expectation(for: idle, evaluatedWith: element("chat.send"))
        waitForExpectations(timeout: 15)
        tap("chat.send")
        XCTAssertTrue(element("chat.thinking").waitForExistence(timeout: 15), app.debugDescription)
        let finished = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element("chat.thinking"))
        XCTAssertEqual(XCTWaiter.wait(for: [finished], timeout: 60), .completed, app.debugDescription)
        let reply = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "LIVE_TEST_OK")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 5), app.debugDescription)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Real reply"; attachment.lifetime = .keepAlways; add(attachment)
    }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    private func require(_ id: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let target = element(id)
        XCTAssertTrue(target.waitForExistence(timeout: 15), "Missing \(id)", file: file, line: line)
        return target
    }
    private func tap(_ id: String) {
        let target = element(id)
        for _ in 0..<8 {
            if target.exists && target.isHittable { target.tap(); return }
            app.swipeUp()
        }
        XCTFail("Missing \(id): \(app.debugDescription)")
    }
}
