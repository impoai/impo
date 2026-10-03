import XCTest

/// Start `node --import tsx scripts/task-list-ui-fixture.ts 3021` before running.
@MainActor final class TaskLoadingUITests: XCTestCase {
    func testLoadingAndFailuresNeverPretendTheTaskListIsEmpty() async throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--reset-demo", "--show-main", "--live-backend", "http://127.0.0.1:3021", "--permission-preview", "allowed"]
        try await control("hold")
        app.launch(); openTasks(app)
        XCTAssertTrue(app.activityIndicators["task.loading"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Get started"].exists)
        try await control("rows")
        XCTAssertTrue(app.buttons["task.row"].waitForExistence(timeout: 10))

        app.buttons["tab.chat"].tap()
        try await control("hold")
        openTasks(app)
        XCTAssertTrue(app.buttons["task.row"].exists, "Refresh must keep the loaded list")
        XCTAssertFalse(app.staticTexts["Get started"].exists)
        try await control("error")
        XCTAssertTrue(app.staticTexts["task.error"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["task.row"].exists)

        app.terminate()
        try await control("error")
        app.launch(); openTasks(app)
        XCTAssertTrue(app.staticTexts["task.error"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Get started"].exists, "A failed first load is not an empty result")
        try await control("hold")
        app.buttons["task.retry"].tap()
        XCTAssertTrue(app.activityIndicators["task.loading"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Get started"].exists)
        try await control("empty")
        XCTAssertTrue(app.staticTexts["Get started"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["task.error"].exists)
    }

    private func openTasks(_ app: XCUIApplication) {
        XCTAssertTrue(app.buttons["tab.tasks"].waitForExistence(timeout: 20))
        app.buttons["tab.tasks"].tap()
    }

    private func control(_ mode: String) async throws {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3021/fixture/tasks?mode=\(mode)")!)
        request.httpMethod = "POST"
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }
}
