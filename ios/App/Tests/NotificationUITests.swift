import XCTest

@MainActor final class NotificationUITests: XCTestCase {
    func testCategoryPreferenceSyncsAndSurvivesRelaunch() async throws {
        var reset = URLRequest(url: URL(string: "http://127.0.0.1:3012/api/v1/notifications/settings")!)
        reset.httpMethod = "PATCH"; reset.setValue("Bearer instant-dev-alice", forHTTPHeaderField: "Authorization")
        reset.setValue("application/json", forHTTPHeaderField: "Content-Type"); reset.httpBody = Data(#"{"chat":true,"tasks":true,"brief":true}"#.utf8)
        let (_, response) = try await URLSession.shared.data(for: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", "http://127.0.0.1:3012", "--permission-preview", "allowed"]
        app.launch(); openSettings(app)
        let tasks = app.switches["notifications.tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 15))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: tasks)], timeout: 15), .completed)
        XCTAssertEqual(tasks.value as? String, "1")
        tasks.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        XCTAssertEqual(tasks.value as? String, "0", tasks.debugDescription)
        try await expectTaskPreference(false)
        let snapshot = XCTAttachment(screenshot: app.screenshot()); snapshot.name = "Notification category preferences"; snapshot.lifetime = .keepAlways; add(snapshot)
        app.terminate(); app.launch(); openSettings(app)
        XCTAssertTrue(tasks.waitForExistence(timeout: 15))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == '0' AND enabled == true"), object: tasks)], timeout: 15), .completed)
        tasks.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap(); try await expectTaskPreference(true)
        XCTAssertEqual(app.switches["notifications.chat"].value as? String, "1")
        XCTAssertEqual(app.switches["notifications.brief"].value as? String, "1")
    }
    private func openSettings(_ app: XCUIApplication) {
        XCTAssertTrue(app.buttons["chat.settings"].waitForExistence(timeout: 20)); app.buttons["chat.settings"].tap()
        XCTAssertTrue(app.buttons["settings.notifications"].waitForExistence(timeout: 10)); app.buttons["settings.notifications"].tap()
    }
    private func expectTaskPreference(_ expected: Bool) async throws {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3012/api/v1/notifications/settings")!)
        request.setValue("Bearer instant-dev-alice", forHTTPHeaderField: "Authorization")
        for _ in 0..<30 {
            let (data, _) = try await URLSession.shared.data(for: request)
            let value = try JSONSerialization.jsonObject(with: data) as! [String: Bool]
            if value["tasks"] == expected { return }
            try await Task.sleep(for: .milliseconds(500))
        }
        XCTFail("Notification preference did not reach the owned API")
    }
}
