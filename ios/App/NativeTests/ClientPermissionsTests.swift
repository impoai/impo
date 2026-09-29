import XCTest
import InstantClient
@testable import Instant

@MainActor final class ClientPermissionsTests: XCTestCase {
    private func fixture(_ notification: NotificationPermission = .notDetermined, _ location: CityPermission = .notDetermined) -> (ClientPermissions, TestNotifications, TestCity, TestContext, UserDefaults) {
        let defaults = UserDefaults(suiteName: "permissions-test-\(UUID())")!
        let notifications = TestNotifications(notification); let city = TestCity(location)
        let model = ClientPermissions(notifications: notifications, city: city, defaults: defaults)
        model.configure(scope: "account-a")
        return (model, notifications, city, TestContext(), defaults)
    }
    func testFirstUseAsksForLocationOnceAndRefreshesOnlyWhenStale() async {
        let (model, _, city, context, _) = fixture()
        await model.activate(context: context)
        XCTAssertEqual(city.requests, [true]); XCTAssertEqual(context.location?.source, .device)
        await model.activate(context: context)
        XCTAssertEqual(city.requests.count, 1)
        context.location = .init(city: "Old city", country: "Country", capturedAt: "2026-01-01T00:00:00Z", source: .device)
        await model.activate(context: context, forceCity: true)
        XCTAssertEqual(city.requests, [true, false])
    }
    func testDenialOffersManualFallbackOnceAndPreservesChosenCity() async {
        let (model, _, _, context, _) = fixture(.notDetermined, .denied)
        context.location = .init(city: "Previous city", country: "Country", capturedAt: "2026-01-01T00:00:00Z")
        await model.activate(context: context)
        XCTAssertNil(context.location); XCTAssertEqual(context.clears, 1); XCTAssertEqual(model.presentation, .city)
        model.presentation = nil
        context.location = .init(city: "Chosen city", country: "Country", capturedAt: "2026-01-01T00:00:00Z", source: .manual)
        await model.activate(context: context)
        XCTAssertEqual(context.location?.city, "Chosen city"); XCTAssertEqual(context.clears, 1)
        XCTAssertNil(model.presentation)
    }
    func testPermissionDeclinedFromSystemPromptGoesToFallback() async {
        let (model, _, city, context, _) = fixture()
        city.denyRequest = true
        await model.activate(context: context)
        XCTAssertEqual(model.cityPermission, .denied); XCTAssertEqual(model.presentation, .city)
        XCTAssertNil(context.location); XCTAssertFalse(model.updatingCity)
    }
    func testDismissingCityFallbackDoesNotNagAfterRelaunch() async {
        let (model, notifications, city, context, defaults) = fixture(.denied, .denied)
        await model.activate(context: context)
        XCTAssertEqual(model.presentation, .city)
        model.presentation = nil
        let relaunched = ClientPermissions(notifications: notifications, city: city, defaults: defaults)
        relaunched.configure(scope: "account-a")
        await relaunched.activate(context: context)
        XCTAssertNil(relaunched.presentation)
        XCTAssertTrue(relaunched.canChooseCity)
        relaunched.configure(scope: "account-b")
        await relaunched.activate(context: context)
        XCTAssertEqual(relaunched.presentation, .city)
    }
    func testAllowOnceExpiryDoesNotCauseAnotherAutomaticPrompt() async {
        let (model, notifications, city, context, defaults) = fixture()
        await model.activate(context: context)
        city.authorization = .notDetermined
        let relaunched = ClientPermissions(notifications: notifications, city: city, defaults: defaults)
        relaunched.configure(scope: "account-a")
        await relaunched.activate(context: context)
        XCTAssertEqual(city.requests.count, 1)
        XCTAssertTrue(relaunched.canChooseCity)
        await relaunched.activate(context: context, forceCity: true)
        XCTAssertEqual(city.requests.count, 2)
    }
    func testNotificationIntroIsContextualOnceAndSettingsChangesHideBadge() async {
        let (model, notifications, _, _, _) = fixture()
        await model.refreshStatus()
        XCTAssertNil(model.presentation); XCTAssertTrue(model.notificationNeedsAttention)
        model.enteredToday(true); XCTAssertEqual(model.presentation, .notifications)
        model.presentation = nil; model.enteredToday(false); model.enteredToday(true)
        XCTAssertNil(model.presentation)
        notifications.current = .denied
        await model.requestNotifications()
        XCTAssertEqual(notifications.requests, 0); XCTAssertTrue(model.notificationNeedsAttention)
        notifications.current = .authorized
        await model.refreshStatus()
        XCTAssertFalse(model.notificationNeedsAttention)
    }
    func testNotificationGrantAndProvisionalAlreadyHavePermission() async {
        let (model, notifications, _, _, _) = fixture()
        await model.requestNotifications()
        XCTAssertEqual(notifications.requests, 1); XCTAssertFalse(model.notificationNeedsAttention)
        for state in [NotificationPermission.provisional, .ephemeral] {
            notifications.current = state; await model.refreshStatus(); await model.requestNotifications()
            XCTAssertFalse(model.notificationNeedsAttention); XCTAssertEqual(notifications.requests, 1)
        }
    }
    func testSwitchingAccountDoesNotSaveAnOldLocationResult() async {
        let (model, _, city, context, _) = fixture(.authorized, .authorized)
        city.hold = true
        let task = Task { await model.activate(context: context) }
        while city.waiting == nil { await Task.yield() }
        context.contextID = UUID(); model.configure(scope: "account-b")
        city.resolve()
        await task.value
        XCTAssertNil(context.location); XCTAssertEqual(context.updates, 0); XCTAssertFalse(model.updatingCity)
    }
    func testTemporaryLocationFailureAllowsManualChoiceAndCanRetry() async {
        let (model, _, city, context, _) = fixture(.authorized, .authorized)
        city.fail = true; await model.activate(context: context)
        XCTAssertTrue(model.canChooseCity); XCTAssertNotNil(model.cityError)
        city.fail = false; await model.activate(context: context, forceCity: true)
        XCTAssertNil(model.cityError); XCTAssertNotNil(context.location)
    }
}

@MainActor private final class TestNotifications: NotificationPermissionReading {
    var current: NotificationPermission; var requests = 0
    init(_ state: NotificationPermission) { current = state }
    func status() async -> NotificationPermission { current }
    func request() async throws { requests += 1; current = .authorized }
}
@MainActor private final class TestCity: CityPermissionReading {
    var authorization: CityPermission; var requests: [Bool] = []; var denyRequest = false; var fail = false; var hold = false
    var waiting: CheckedContinuation<TodayLocation, Error>?
    init(_ state: CityPermission) { authorization = state }
    func read(requestPermission: Bool) async throws -> TodayLocation {
        requests.append(requestPermission)
        if denyRequest { authorization = .denied; throw TodayCityReader.CityError.denied }
        if fail { throw TodayCityReader.CityError.unavailable }
        authorization = .authorized
        if hold { return try await withCheckedThrowingContinuation { waiting = $0 } }
        return sample
    }
    var sample: TodayLocation { .init(city: "Test city", country: "Test country", capturedAt: ISO8601DateFormatter().string(from: Date()), source: .device) }
    // Deliberately deliver after cancellation to verify the account fence as well.
    func cancel() {}
    func resolve() { waiting?.resume(returning: sample); waiting = nil }
}
@MainActor private final class TestContext: PermissionContext {
    var isLive = true; var contextID = UUID(); var location: TodayLocation?; var clears = 0; var updates = 0
    func updateLocation(_ location: TodayLocation?, clear: Bool) async throws {
        updates += 1
        if clear { self.location = nil; clears += 1 } else { self.location = location }
    }
}
