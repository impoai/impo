import XCTest

@MainActor final class PermissionUITests: XCTestCase {
    private func app(_ state: String, live: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--permission-preview", state]
        if live { app.launchArguments += ["--live-backend", "http://127.0.0.1:3009"] }
        app.launch(); return app
    }
    func testDeniedNotificationBadgeExplainsSettings() {
        let app = app("denied")
        let badge = app.buttons["permissions.notifications"]
        XCTAssertTrue(badge.waitForExistence(timeout: 10)); badge.tap()
        XCTAssertTrue(app.buttons["permissions.notification-settings"].waitForExistence(timeout: 5))
        snapshot("Denied notifications guidance", app)
        app.buttons["permissions.not-now"].tap()
        app.buttons["tab.today"].tap()
        XCTAssertTrue(badge.waitForExistence(timeout: 5))
        snapshot("Today notification permission badge", app)
    }
    func testGrantHidesNotificationBadge() {
        let app = app("ask")
        let badge = app.buttons["permissions.notifications"]
        XCTAssertTrue(badge.waitForExistence(timeout: 10)); badge.tap()
        let enable = app.buttons["permissions.enable-notifications"]
        XCTAssertTrue(enable.waitForExistence(timeout: 5)); enable.tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: badge)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
        app.buttons["tab.today"].tap()
        XCTAssertFalse(badge.exists)
        snapshot("Allowed notifications hide the badge", app)
    }
    func testManualCityPersistsThroughRealAPIAndRelaunch() async throws {
        // Clear only the local QA account's optional city to exercise first-use fallback.
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3009/api/v1/today/settings")!)
        request.httpMethod = "PUT"; request.setValue("Bearer instant-dev-alice", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(#"{"timeZone":"Asia/Shanghai","locale":"zh-Hans","location":null}"#.utf8)
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = app("denied", live: true)
        let city = app.textFields["permissions.city-field"]
        XCTAssertTrue(city.waitForExistence(timeout: 15)); city.tap(); city.typeText("Shanghai")
        app.textFields["permissions.country-field"].tap(); app.textFields["permissions.country-field"].typeText("China")
        snapshot("Location denied city fallback", app)
        app.buttons["permissions.save-city"].tap()
        XCTAssertTrue(app.buttons["tab.today"].waitForExistence(timeout: 10)); app.buttons["tab.today"].tap()
        app.buttons["today.settings"].tap()
        assertCity("Shanghai", app)
        snapshot("Saved manual city and system language", app)
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["tab.today"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.textFields["permissions.city-field"].exists)
        app.buttons["tab.today"].tap(); app.buttons["today.settings"].tap()
        assertCity("Shanghai", app)

    }
    func testSystemLocationAndNotificationAuthorization() async throws {
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", "http://127.0.0.1:3009", "--system-permission-test"]
        app.launch()
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let locationAllow = system.buttons["Allow While Using App"]
        XCTAssertTrue(locationAllow.waitForExistence(timeout: 15), system.debugDescription)
        snapshot("Real system location permission", app)
        locationAllow.tap()
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3009/api/v1/today/settings")!)
        request.setValue("Bearer instant-dev-alice", forHTTPHeaderField: "Authorization")
        var source = ""
        for _ in 0..<30 {
            let (data, _) = try await URLSession.shared.data(for: request)
            let body = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            let location = (body["settings"] as? [String: Any])?["location"] as? [String: Any]
            source = location?["source"] as? String ?? ""
            if source == "device" { break }
            try await Task.sleep(for: .seconds(1))
        }
        XCTAssertEqual(source, "device", "Actual Core Location and reverse geocoding must reach the real API")
        app.buttons["tab.today"].tap()
        let enable = app.buttons["permissions.enable-notifications"]
        XCTAssertTrue(enable.waitForExistence(timeout: 10)); enable.tap()
        let allow = system.alerts.buttons["Allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 10), system.debugDescription)
        snapshot("Real system notification permission", app)
        allow.tap()
        let badge = app.buttons["permissions.notifications"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: badge)], timeout: 10), .completed)
        app.buttons["today.settings"].tap()
        let row = app.descendants(matching: .any).matching(identifier: "today.city").firstMatch
        for _ in 0..<4 { if row.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(row.exists)
        snapshot("Automatic city after real system authorization", app)
    }
    private func assertCity(_ expected: String, _ app: XCUIApplication) {
        let row = app.descendants(matching: .any).matching(identifier: "today.city").firstMatch
        for _ in 0..<4 { if row.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(row.exists)
        XCTAssertTrue(row.label.contains(expected) || (row.value as? String ?? "").contains(expected), row.debugDescription)
    }
    private func snapshot(_ name: String, _ app: XCUIApplication) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
}
