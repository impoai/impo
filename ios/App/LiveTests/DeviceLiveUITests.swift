import XCTest

/// Opt-in scheme InstantDeviceLive. Needs local API/Worker with the Rebyte runtime.
/// Uses actual Simulator permissions and native readers, not injected tool results.
@MainActor
final class DeviceLiveUITests: XCTestCase {
    private let app = XCUIApplication()

    func testCalendarAndHealthNativeToolConversation() throws {
        continueAfterFailure = false
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", "http://127.0.0.1:3001"]
        app.launch()
        tap("chat.settings")
        tap("settings.connections")
        tap("connection.calendar")
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.alerts.firstMatch.waitForExistence(timeout: 4) {
            let allow = springboard.alerts.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Allow Full Access")).firstMatch
            XCTAssertTrue(allow.waitForExistence(timeout: 5), springboard.alerts.debugDescription)
            allow.tap()
        }
        XCTAssertTrue(element("connection.calendar.disconnect").waitForExistence(timeout: 8))
        tap("connection.health")
        // Health authorization is a system sheet, distinct from an alert.
        let turnOn = app.cells["UIA.Health.AuthSheet.AllCategoryButton"]
        if turnOn.waitForExistence(timeout: 5) {
            turnOn.tap()
            let allowHealth = app.buttons["UIA.Health.Allow.Button"]
            let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: allowHealth)
            XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 5), .completed)
            allowHealth.tap()
        }
        XCTAssertTrue(element("connection.health.disconnect").waitForExistence(timeout: 10), app.debugDescription)
        capture("Native Calendar and Health permission review")
        app.buttons["Back"].firstMatch.tap()
        app.buttons["Back"].firstMatch.tap()

        let input = element("chat.input")
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        let idle = NSPredicate(format: "enabled == true")
        expectation(for: idle, evaluatedWith: element("chat.send"))
        // The send button needs text before it is enabled.
        let prompt = "请分别调用 iPhone 日历和 Health 工具，查询今天的日历事件、步数和活动能量。输出里写明两个工具结果的 source 字段。没有可读健康数据就明确说未知，不要当成零，也不要编造。"
        input.tap(); input.typeText(prompt)
        waitForExpectations(timeout: 30)
        tap("chat.send")
        XCTAssertTrue(element("chat.thinking").waitForExistence(timeout: 15))
        let finished = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element("chat.thinking"))
        XCTAssertEqual(XCTWaiter.wait(for: [finished], timeout: 150), .completed)
        let calendarSource = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "ios.eventkit")).firstMatch
        let healthSource = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "ios.healthkit")).firstMatch
        XCTAssertTrue(calendarSource.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(healthSource.exists, app.debugDescription)
        capture("Native device results through Rebyte")
        app.terminate()
        app.launchArguments = ["--show-main", "--live-backend", "http://127.0.0.1:3001"]
        app.launch()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "ios.eventkit")).firstMatch.waitForExistence(timeout: 20))
    }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    private func tap(_ id: String) {
        let target = element(id)
        for _ in 0..<8 {
            if target.exists && target.isHittable { target.tap(); return }
            app.swipeUp()
        }
        XCTFail("Missing \(id): \(app.debugDescription)")
    }
    private func capture(_ name: String) {
        let item = XCTAttachment(screenshot: app.screenshot())
        item.name = name; item.lifetime = .keepAlways; add(item)
    }
}
