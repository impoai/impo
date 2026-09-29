import XCTest

@MainActor final class AssistantAvatarUITests: XCTestCase {
    private let names = ["Fox", "Robin", "Cat", "Impo", "Owl", "Otter"]

    func testSixLooksInOnboardingAndSavedAssistantChoice() {
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--onboarding-step", "5", "--permission-preview", "allowed"]
        app.launch()
        for (index, name) in names.enumerated() {
            let choice = app.buttons["onboarding.avatar.\(index)"]
            XCTAssertTrue(choice.waitForExistence(timeout: 5)); XCTAssertEqual(choice.label, "\(name) avatar")
        }
        app.buttons["onboarding.avatar.2"].tap()
        XCTAssertTrue(app.buttons["onboarding.avatar.2"].isSelected)
        capture("Six generated avatar choices in onboarding", app)
        app.terminate()
        app.launchArguments = ["--show-main", "--permission-preview", "allowed"]
        app.launch()
        XCTAssertTrue(app.buttons["chat.assistant"].waitForExistence(timeout: 10))
        app.buttons["chat.assistant"].tap()
        XCTAssertTrue(app.buttons["assistant.avatar.2"].isSelected)
        for (index, name) in names.enumerated() {
            let choice = app.buttons["assistant.avatar.\(index)"]
            XCTAssertEqual(choice.label, "\(name) avatar"); choice.tap()
            XCTAssertTrue(choice.isSelected)
            capture("Assistant avatar — \(name)", app)
        }
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["chat.assistant"].waitForExistence(timeout: 10))
        capture("Otter avatar in chat after relaunch", app)
        app.buttons["chat.assistant"].tap()
        XCTAssertTrue(app.buttons["assistant.avatar.5"].isSelected)
    }

    private func capture(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
