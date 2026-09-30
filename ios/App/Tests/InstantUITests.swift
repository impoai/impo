import XCTest

@MainActor
final class InstantUITests: XCTestCase {
    private lazy var app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testOnboardingChatAndRelaunch() {
        app.launchArguments = ["--reset-demo"]
        app.launch()
        require("onboarding.begin")
        let unexpectedAdvance = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true"),
            object: element("onboarding.login")
        )
        XCTAssertEqual(XCTWaiter.wait(for: [unexpectedAdvance], timeout: 1), .timedOut)
        capture("01 Welcome waits for Begin")
        tap("onboarding.begin")
        require("onboarding.login")
        capture("02 Sign in preview")
        // Every login option here needs something this regression test can't
        // provide headlessly: OAuth needs a native system consent sheet, and
        // this Clerk Application has no password sign-in strategy configured
        // at all (only OAuth + email code) - see ClerkAuthLiveUITests for how
        // the opt-in live tests actually exercise real sign-in, with a
        // server-minted one-time token. So this regression test instead
        // covers the login screen's own rendering, then relaunches past it
        // with the existing --onboarding-step bypass to keep covering the
        // rest of onboarding and chat without a real backend/account.
        app.terminate()
        app.launchArguments = ["--onboarding-step", "2"]
        app.launch()
        require("onboarding.connect.calendar")
        XCTAssertTrue(element("onboarding.connections.continue").isEnabled)
        capture("04 Connections")

        tap("onboarding.connect.calendar")
        require("connection.calendar")
        capture("05 Calendar permission entry")
        tap("onboarding.permission.done")
        XCTAssertTrue(element("onboarding.connections.continue").isEnabled)
        tap("onboarding.connect.reminders")
        require("connection.reminders")
        capture("06 Reminders permission entry")
        tap("onboarding.permission.done")
        require("onboarding.connect.contacts")
        scrollTo("onboarding.connect.gmail")
        capture("06b Apps in onboarding")
        XCTAssertTrue(element("onboarding.connections.continue").isEnabled)
        tap("onboarding.connections.continue")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "introduce ourselves.")).firstMatch.waitForExistence(timeout: 8))
        capture("07 Introduction")
        tap("onboarding.intro.continue")

        let name = require("onboarding.name.field")
        name.tap()
        name.typeText("Luna")
        capture("08 Name assistant")
        tap("onboarding.name.continue")
        require("onboarding.avatar.continue")
        XCTAssertTrue(app.staticTexts["Pick a look for Luna!"].exists)
        tap("onboarding.avatar.2")
        capture("09 Choose assistant appearance")
        tap("onboarding.avatar.continue")
        // There is no plan or payment step; the avatar finishes onboarding.
        require("chat.input")
        capture("11 Main conversation")

        send("Hello")
        XCTAssertTrue(app.staticTexts["Hey! How's your day going?"].waitForExistence(timeout: 8))
        capture("12 Conversation reply")
        app.terminate()
        app.launchArguments = []
        app.launch()
        require("chat.input")
        XCTAssertFalse(element("onboarding.begin").exists)
        XCTAssertTrue(app.staticTexts["Hey! How's your day going?"].waitForExistence(timeout: 8))
        XCTAssertTrue(element("chat.assistant").label.contains("Luna"))
        capture("13 Reopened conversation")
        let chineseInput = require("chat.input")
        chineseInput.tap()
        chineseInput.typeText("你好，帮我安排今天")
        XCTAssertEqual(chineseInput.value as? String, "你好，帮我安排今天")
        let keyboardSend = app.keyboards.buttons.matching(NSPredicate(format: "label ==[c] %@", "Send")).firstMatch
        XCTAssertTrue(keyboardSend.waitForExistence(timeout: 5))
        keyboardSend.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "我可以帮你梳理想法")).firstMatch.waitForExistence(timeout: 8))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        capture("14 Chinese conversation sent with keyboard")
    }

    func testTabsSettingsProfileAndMemoryCategories() {
        launchMain()
        XCTAssertTrue(require("tab.today").label.contains("Brief"))
        tap("tab.today")
        XCTAssertTrue(app.staticTexts["Today"].firstMatch.waitForExistence(timeout: 5))
        capture("20 Today")
        tap("tab.tasks")
        require("task.add")
        require("task.template.priority-list")
        capture("21 Tasks get started")
        tap("task.category.work")
        require("task.template.meeting-prep")
        tap("task.segment.scheduled")
        require("task.scheduled.placeholder")
        tap("task.segment.tasks")
        tap("task.template.meeting-prep")
        require("task.new.input")
        capture("21a New task prefilled from a template")
        tap("task.new.send")
        require("task.message.user")
        XCTAssertTrue(element("task.message.assistant").waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Completed"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "task.message.assistant").count, 1, "one request gets exactly one reply")
        capture("21b Task conversation")
        tap("task.back")
        require("task.row")
        XCTAssertTrue(require("task.updatedAt").label.contains("Last updated Just now"))
        capture("21c Tasks list")

        tap("tab.memories")
        app.buttons["About you"].tap()
        require("memories.profile")
        capture("22 Memories")
        tap("memories.profile")
        require("profile.edit")
        capture("23 Profile detail")
        tap("profile.edit")
        let profileName = app.alerts["Your name"].textFields.firstMatch
        XCTAssertTrue(profileName.waitForExistence(timeout: 5))
        replaceText(profileName, with: "Taylor")
        app.alerts.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["What I know about Taylor"].waitForExistence(timeout: 5))
        back()
        require("memories.category.health")
        for category in ["personal_details", "user_preferences", "family", "professional_details"] { require("memories.category.\(category)") }
        capture("24 Memory categories")
        tap("memories.category.professional_details")
        require("memories.empty")
        capture("25 Work memories")
        back()
        scrollTo("memories.category.misc")
        scrollTo("memories.compose")

        tap("tab.chat")
        tap("chat.assistant")
        require("assistant.editName")
        capture("26 Assistant")
        tap("tab.chat")
        tap("chat.settings")
        require("settings.profile")
        XCTAssertFalse(element("settings.manage").exists, "Demo plan screens stay hidden outside Debug mode")
        capture("27 Settings")
        tap("settings.connections")
        require("connection.calendar")
        capture("28 Connections settings")
        back()
        back()
        require("chat.input")

        app.terminate()
        app.launchArguments = ["--show-main"]
        app.launch()
        tap("tab.memories")
        app.buttons["About you"].tap()
        XCTAssertTrue(element("memories.profile").label.contains("Taylor"))
        tap("memories.category.personal_details")
        XCTAssertTrue(app.staticTexts["About Taylor"].waitForExistence(timeout: 5))
        back()
        tap("tab.tasks")
        require("task.row")
    }

    func testScenarioSearchAndVoicePreview() {
        launchMain()
        let arrowBefore = require("scenario.next").frame
        tap("scenario.next")
        // The chat is bottom-anchored; a shorter second page must not move the page arrows.
        let settled = expectation(description: "Page arrows settle")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { settled.fulfill() }
        wait(for: [settled], timeout: 2)
        XCTAssertEqual(require("scenario.next").frame.minY, arrowBefore.minY, accuracy: 1)
        capture("30 Scenario choices second page")
        tap("scenario.other")
        XCTAssertTrue(app.staticTexts["Answered: Something else"].waitForExistence(timeout: 5))
        send("Hello")
        XCTAssertTrue(app.staticTexts["Hey! How's your day going?"].waitForExistence(timeout: 8))
        tap("chat.search")
        let search = require("chat.search.field")
        search.tap()
        search.typeText("not-in-this-conversation")
        XCTAssertTrue(app.staticTexts["No messages found"].waitForExistence(timeout: 5))
        capture("31 Empty conversation search")
        tap("chat.search")

        // Hold to talk with a fixed transcript: "…" while transcribing, then the sent message.
        app.terminate()
        app.launchArguments = ["--reset-demo", "--show-main", "--voice-fixture", "Help me plan my day"]
        app.launch()
        let voice = require("chat.voice")
        let before = app.descendants(matching: .any).matching(identifier: "chat.message.user").count
        voice.press(forDuration: 1.2)
        XCTAssertTrue(element("chat.voice.transcribing").waitForExistence(timeout: 2), "Released speech shows a pending bubble")
        capture("32 Voice transcribing")
        XCTAssertTrue(app.staticTexts["Help me plan my day"].waitForExistence(timeout: 5))
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element("chat.voice.transcribing"))
        wait(for: [gone], timeout: 5)
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "chat.message.user").count, before + 1)
        // Slide up to cancel: nothing is sent.
        let start = voice.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.8, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -220)))
        XCTAssertFalse(element("chat.voice.transcribing").waitForExistence(timeout: 1.5))
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "chat.message.user").count, before + 1)

        app.terminate()
        app.launchArguments = ["--reset-demo", "--show-main", "--voice-preview"]
        app.launch()
        require("voice.preview")
        capture("33 Voice overlay")
    }

    /// Runs only when a local development server is supplied, e.g.
    /// TEST_RUNNER_IMPO_UI_LIVE_BACKEND=http://127.0.0.1:3001 xcodebuild test ...
    func testTaskLifecycleAgainstLocalServer() throws {
        guard let backend = ProcessInfo.processInfo.environment["IMPO_UI_LIVE_BACKEND"] else {
            throw XCTSkip("Set TEST_RUNNER_IMPO_UI_LIVE_BACKEND to a local development server")
        }
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", backend]
        app.launch()
        require("chat.input")
        tap("tab.tasks")
        require("task.add")
        tap("task.add")
        let add = app.buttons["Add a Task"]
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        capture("30 Add menu")
        add.tap()
        let input = require("task.new.input")
        input.tap()
        input.typeText("Plan a quiet afternoon \(UUID().uuidString.prefix(6))")
        tap("task.new.send")
        require("task.message.user")
        XCTAssertTrue(element("task.message.assistant").waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Completed"].waitForExistence(timeout: 15))
        capture("31 Live task finished")
        let followUp = require("task.detail.input")
        followUp.tap()
        followUp.typeText("hi")
        tap("task.detail.send")
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "task.message.user").element(boundBy: 1).waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "task.message.assistant").element(boundBy: 1).waitForExistence(timeout: 15))
        capture("32 Live follow-up")
        tap("task.back")
        require("task.row")
        capture("33 Live tasks list")
    }

    func testChatKeepsReadingPositionAndOffersScrollToBottom() {
        launchMain()
        for index in 1...8 { send("Scroll probe \(index) " + String(repeating: "long line ", count: 12)) }
        let button = element("chat.scrollToBottom")
        XCTAssertFalse(button.waitForExistence(timeout: 2), "At the bottom no button is shown")

        // Read older messages: the list must stay put and offer a way back.
        let list = app.scrollViews.firstMatch
        list.swipeDown(); list.swipeDown()
        XCTAssertTrue(button.waitForExistence(timeout: 3), "Away from the bottom the button appears")
        let anchor = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Scroll probe 3'")).firstMatch
        XCTAssertTrue(anchor.waitForExistence(timeout: 3))
        let input = require("chat.input")
        input.tap(); input.typeText("Sent while reading")
        let before = anchor.frame.minY
        require("chat.send").tap()
        sleep(3) // the demo reply arrives meanwhile
        XCTAssertEqual(anchor.frame.minY, before, accuracy: 2, "Sending while scrolled up does not move the list")
        XCTAssertTrue(button.exists, "The button stays until the reader returns")
        capture("Chat scrolled up with scroll-to-bottom")

        button.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label == 'Sent while reading'")).firstMatch.waitForExistence(timeout: 3))
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: button)
        wait(for: [gone], timeout: 3)
    }

    func testLeftEdgeSwipeGoesBackEverywhere() {
        // In-place page: Settings returns to the chat.
        launchMain()
        tap("chat.settings")
        require("settings.back")
        edgeSwipe()
        XCTAssertTrue(require("chat.input").exists)
        XCTAssertFalse(element("settings.back").exists)

        // Sheet from Settings: dismisses back to Settings, not further.
        tap("chat.settings")
        tap("settings.connections")
        let sheetTitle = app.staticTexts["Make a little more possible."]
        XCTAssertTrue(sheetTitle.waitForExistence(timeout: 5))
        edgeSwipe()
        let dismissed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: sheetTitle)
        wait(for: [dismissed], timeout: 5)
        XCTAssertTrue(require("settings.back").exists)

        // A short drag or one away from the edge does not go back.
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.55)))
        XCTAssertTrue(require("settings.back").exists)

        // Onboarding: the edge swipe returns to the previous step.
        app.terminate()
        app.launchArguments = ["--onboarding-step", "3"]
        app.launch()
        require("onboarding.intro.continue")
        edgeSwipe()
        require("onboarding.connections.continue")
    }

    /// A drag from the screen's left edge to the right, like the system back gesture.
    private func edgeSwipe() {
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.55))
        from.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.55)), withVelocity: .fast, thenHoldForDuration: 0)
    }

    private func launchMain() {
        app.launchArguments = ["--reset-demo", "--show-main"]
        app.launch()
        require("chat.input")
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    @discardableResult
    private func require(_ identifier: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let target = element(identifier)
        XCTAssertTrue(target.exists || target.waitForExistence(timeout: 10), "Missing \(identifier)", file: file, line: line)
        return target
    }

    private func scrollTo(_ identifier: String, file: StaticString = #filePath, line: UInt = #line) {
        let target = element(identifier)
        for _ in 0..<6 {
            if target.exists && target.isHittable { return }
            app.swipeUp()
        }
        XCTAssertTrue(target.exists && target.isHittable, "Cannot reach \(identifier)", file: file, line: line)
    }

    private func tap(_ identifier: String, file: StaticString = #filePath, line: UInt = #line) {
        scrollTo(identifier, file: file, line: line)
        require(identifier, file: file, line: line).tap()
    }

    private func back(file: StaticString = #filePath, line: UInt = #line) {
        let backButton = app.buttons["Back"].firstMatch
        XCTAssertTrue(backButton.waitForExistence(timeout: 5), file: file, line: line)
        backButton.tap()
    }

    private func send(_ text: String) {
        let input = require("chat.input")
        input.tap()
        input.typeText(text)
        XCTAssertEqual(input.value as? String, text)
        tap("chat.send")
    }

    private func replaceText(_ field: XCUIElement, with text: String) {
        field.tap()
        let previous = field.value as? String ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: previous.count) + text)
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
