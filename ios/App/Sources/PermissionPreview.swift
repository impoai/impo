import Foundation
import InstantClient

extension ClientPermissions {
    static func make() -> ClientPermissions {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--system-permission-test") {
            UserDefaults.standard.removeObject(forKey: "impo.permissions.locationAsked")
            UserDefaults.standard.removeObject(forKey: "impo.permissions.notificationsOffered")
        }
        if let index = ProcessInfo.processInfo.arguments.firstIndex(of: "--permission-preview"), ProcessInfo.processInfo.arguments.indices.contains(index + 1) {
            let value = ProcessInfo.processInfo.arguments[index + 1]
            let defaults = UserDefaults(suiteName: "ai.impo.permissions-preview")!
            defaults.removePersistentDomain(forName: "ai.impo.permissions-preview")
            return ClientPermissions(notifications: PreviewNotifications(value), city: PreviewCity(), defaults: defaults)
        }
        #endif
        return ClientPermissions()
    }
}
#if DEBUG
@MainActor private final class PreviewNotifications: NotificationPermissionReading {
    var state: NotificationPermission
    init(_ value: String) { state = value == "allowed" ? .authorized : value == "denied" ? .denied : .notDetermined }
    func status() async -> NotificationPermission { state }
    func request() async throws { state = .authorized }
}
@MainActor private final class PreviewCity: CityPermissionReading {
    var authorization: CityPermission { .denied }
    func read(requestPermission: Bool) async throws -> TodayLocation { throw TodayCityReader.CityError.denied }
    func cancel() {}
}
#endif
