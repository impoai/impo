import Foundation
import XCTest
@testable import Instant

/// One device, several accounts: local state belongs to exactly one of them.
@MainActor
final class AccountIsolationTests: XCTestCase {
    private func defaults() throws -> (UserDefaults, String) {
        let suite = "AccountIsolationTests.\(UUID().uuidString)"
        return (try XCTUnwrap(UserDefaults(suiteName: suite)), suite)
    }

    private func seedAccount(_ defaults: UserDefaults, owner: String?) {
        if let owner { defaults.set(owner, forKey: AppModel.accountOwnerKey) }
        defaults.set(true, forKey: "instant.onboarded")
        defaults.set("Robin", forKey: "instant.name")
        defaults.set("Alex", forKey: "instant.displayName")
        defaults.set(2, forKey: "instant.avatar")
        defaults.set(Data([1, 2, 3]), forKey: "instant.avatarPhoto")
        defaults.set(["gmail"], forKey: "instant.connections")
        defaults.set(true, forKey: "instant.device.calendarEnabled")
        defaults.set(true, forKey: "instant.device.healthEnabled")
        defaults.set(Data(#"{"http://127.0.0.1:3001|clerk":{"clientID":"c1","text":"private note"}}"#.utf8), forKey: "instant.pendingLiveInputs")
        defaults.set("install-1", forKey: "instant.installationID")
        defaults.set("http://127.0.0.1:3001", forKey: "instant.backend")
        defaults.set(true, forKey: "instant.listening.wifiOnly.scope-a")
    }

    private func pendingKeys(_ defaults: UserDefaults) -> Set<String> {
        guard let data = defaults.data(forKey: "instant.pendingLiveInputs"),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        return Set(object.keys)
    }

    func testAnotherAccountNeverInheritsLocalAccountState() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        seedAccount(defaults, owner: "clerk:user_A")
        let model = AppModel(defaults: defaults)
        XCTAssertEqual(model.assistantName, "Robin")

        model.adoptAccount("clerk:user_B")

        XCTAssertFalse(model.isOnboarded)
        XCTAssertEqual(model.assistantName, "Momo")
        XCTAssertEqual(model.displayName, "")
        XCTAssertEqual(model.avatarIndex, 3)
        XCTAssertTrue(model.connectedServices.isEmpty)
        XCTAssertFalse(model.calendarEnabled)
        XCTAssertFalse(model.healthEnabled)
        for key in ["instant.onboarded", "instant.name", "instant.displayName", "instant.avatar", "instant.avatarPhoto",
                    "instant.connections", "instant.device.calendarEnabled", "instant.device.healthEnabled", "instant.pendingLiveInputs"] {
            XCTAssertNil(defaults.object(forKey: key), key)
        }
        // Device identity, server choice and already account-scoped Echo settings stay.
        XCTAssertEqual(defaults.string(forKey: "instant.installationID"), "install-1")
        XCTAssertEqual(defaults.string(forKey: "instant.backend"), "http://127.0.0.1:3001")
        XCTAssertTrue(defaults.bool(forKey: "instant.listening.wifiOnly.scope-a"))
        XCTAssertEqual(defaults.string(forKey: AppModel.accountOwnerKey), "clerk:user_B")

        // A fresh launch sees B's (empty) state, not A's.
        let reopened = AppModel(defaults: defaults)
        XCTAssertFalse(reopened.isOnboarded)
        XCTAssertEqual(reopened.assistantName, "Momo")
    }

    func testSameAccountKeepsItsLocalState() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        seedAccount(defaults, owner: "clerk:user_A")
        let model = AppModel(defaults: defaults)

        model.adoptAccount("clerk:user_A")

        XCTAssertTrue(model.isOnboarded)
        XCTAssertEqual(model.assistantName, "Robin")
        XCTAssertTrue(model.calendarEnabled)
        XCTAssertEqual(pendingKeys(defaults), ["http://127.0.0.1:3001|clerk"])
    }

    func testLegacySharedInputSlotMovesToTheFirstRecordedOwnerOnly() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        seedAccount(defaults, owner: nil)
        let model = AppModel(defaults: defaults)

        model.adoptAccount("clerk:user_A")
        XCTAssertEqual(pendingKeys(defaults), ["http://127.0.0.1:3001|clerk:user_A"])
        XCTAssertEqual(model.assistantName, "Robin")

        // B can neither see nor resend A's unconfirmed message.
        model.adoptAccount("clerk:user_B")
        XCTAssertEqual(pendingKeys(defaults), [])
    }

    func testTasksOfAnotherAccountAreNotShown() {
        let tasks = TasksModel()
        tasks.configure(scope: "https://api.example|clerk:user_A")
        tasks.tasks = [TaskItem(id: "t1", title: "A's private goal", status: "completed", createdAt: Date())]
        tasks.route = .detail("t1")
        tasks.loadError = "stale"

        tasks.configure(scope: "https://api.example|clerk:user_A")
        XCTAssertEqual(tasks.tasks.count, 1)

        tasks.configure(scope: "https://api.example|clerk:user_B")
        XCTAssertTrue(tasks.tasks.isEmpty)
        XCTAssertNil(tasks.route)
        XCTAssertNil(tasks.loadError)
    }
}
