import Foundation
import SwiftUI
import UserNotifications
import FirebaseCore
@preconcurrency import FirebaseMessaging
import InstantClient
import CryptoKit

@MainActor @Observable final class PushNotifications: NSObject {
    static let shared = PushNotifications()
    var preferences = NotificationPreferences()
    var error: String?
    var loaded = false
    var permissionAllowed = false
    var pendingRoute: PushRoute?
    private(set) var registrationId: String?
    private(set) var configured = false
    @ObservationIgnored private var client: InstantClient?
    @ObservationIgnored private var scope: String?
    @ObservationIgnored private var foreground = true
    @ObservationIgnored private var token: String?
    @ObservationIgnored private var requestedAPNS = false
    @ObservationIgnored private var syncing = false
    @ObservationIgnored private var syncAgain = false
    @ObservationIgnored private var syncWaiters: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private var pending: [String: Bool] = [:]
    @ObservationIgnored private let defaults = UserDefaults.standard
    private var installationId: String { persistentID("installation") }
    private var installationSecret: String { persistentID("secret") }
    private func persistentID(_ key: String) -> String {
        let name = "impo.push." + key
        if let value = defaults.string(forKey: name) { return value }
        let value = UUID().uuidString.lowercased(); defaults.set(value, forKey: name); return value
    }
    private func nextRevision() -> Int {
        let value = defaults.integer(forKey: "impo.push.revision") + 1
        defaults.set(value, forKey: "impo.push.revision"); return value
    }
    private var preferencesKey: String { "impo.push.preferences." + SHA256.hash(data: Data((scope ?? "").utf8)).map { String(format: "%02x", $0) }.joined() }
    func start() {
        guard !configured, let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"), let options = FirebaseOptions(contentsOfFile: path) else { return }
        if FirebaseApp.app() == nil { FirebaseApp.configure(options: options) }
        configured = true
        Messaging.messaging().delegate = self
        UNUserNotificationCenter.current().delegate = self
    }
    func configure(scope: String?, client: InstantClient?) {
        self.client = client
        guard self.scope != scope || (scope != nil && registrationId == nil) else { return }
        self.scope = scope; error = nil; loaded = false
        preferences = NotificationPreferences(); pending = [:]
        if let scope {
            if defaults.string(forKey: "impo.push.scope") == scope { registrationId = defaults.string(forKey: "impo.push.registration") }
            else { registrationId = nil; pendingRoute = nil; UNUserNotificationCenter.current().removeAllDeliveredNotifications() }
            if registrationId == nil { registrationId = UUID().uuidString.lowercased() }
            defaults.set(scope, forKey: "impo.push.scope"); defaults.set(registrationId, forKey: "impo.push.registration")
            if let data = defaults.data(forKey: preferencesKey), let saved = try? JSONDecoder().decode(NotificationPreferences.self, from: data) { preferences = saved }
            pending = defaults.dictionary(forKey: preferencesKey + ".pending") as? [String: Bool] ?? [:]
        } else {
            registrationId = nil; pendingRoute = nil
            defaults.removeObject(forKey: "impo.push.scope"); defaults.removeObject(forKey: "impo.push.registration")
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        }
        Task { await refresh() }
    }
    func setForeground(_ value: Bool) {
        foreground = value
        let backgroundTask = value ? nil : PushPresenceBackgroundTask()
        Task {
            await refresh()
            backgroundTask?.end()
        }
    }
    func set(_ category: NotificationCategory, enabled: Bool) {
        guard scope != nil else { return }
        preferences[category] = enabled; pending[category.rawValue] = enabled
        persist(); Task { await refresh() }
        if !enabled { removeDelivered(category) }
    }
    private func persist() {
        if let data = try? JSONEncoder().encode(preferences) { defaults.set(data, forKey: preferencesKey) }
        defaults.set(pending, forKey: preferencesKey + ".pending")
    }
    func refresh() async {
        if syncing {
            syncAgain = true
            await withCheckedContinuation { syncWaiters.append($0) }
            return
        }
        syncing = true
        defer {
            syncing = false
            if syncAgain { syncAgain = false; Task { await refresh() } }
            else { let waiting = syncWaiters; syncWaiters = []; waiting.forEach { $0.resume() } }
        }
        guard let scope, let client, let registrationId else { return }
        do {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            guard self.scope == scope, self.registrationId == registrationId else { return }
            permissionAllowed = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
            if configured && permissionAllowed {
                Messaging.messaging().isAutoInitEnabled = true
                if !requestedAPNS { requestedAPNS = true; UIApplication.shared.registerForRemoteNotifications() }
                // APNs/Messaging callbacks obtain the token; presence must not wait on FCM networking.
            }
            guard self.scope == scope, self.registrationId == registrationId else { return }
            // Register presence first, even if permission is off. Revisions fence a slow older transition.
            _ = try await client.registerPush(installationId: installationId, installationSecret: installationSecret, revision: nextRevision(), registrationId: registrationId,
                token: permissionAllowed ? token : nil, enabled: permissionAllowed && configured, foreground: foreground)
            guard self.scope == scope, self.registrationId == registrationId else { return }
            for (key, enabled) in pending {
                guard let category = NotificationCategory(rawValue: key) else { continue }
                let saved = try await client.updateNotificationPreference(category, enabled: enabled)
                guard self.scope == scope, self.registrationId == registrationId else { return }
                if pending[key] == enabled { pending.removeValue(forKey: key) }
                preferences = saved
                for (name, value) in pending { if let category = NotificationCategory(rawValue: name) { preferences[category] = value } }
                persist()
            }
            let saved = try await client.notificationPreferences()
            guard self.scope == scope, self.registrationId == registrationId else { return }
            preferences = saved
            for (name, value) in pending { if let category = NotificationCategory(rawValue: name) { preferences[category] = value } }
            loaded = true; error = nil; persist()
        } catch {
            guard self.scope == scope, self.registrationId == registrationId else { return }
            self.error = "Notification settings couldn't sync. We'll retry when you're connected."
        }
    }
    func revokeBeforeSignOut() async throws {
        guard let client, let registrationId else { return }
        // Invalidate first: a completing heartbeat cannot restore this registration.
        let revision = nextRevision()
        self.registrationId = nil
        do { try await client.revokePush(installationId: installationId, installationSecret: installationSecret, revision: revision, registrationId: registrationId) }
        catch { if (error as? InstantAPIError)?.statusCode != 404 { self.registrationId = registrationId; throw error } }
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        defaults.removeObject(forKey: "impo.push.scope"); defaults.removeObject(forKey: "impo.push.registration")
        token = nil
        if configured { Messaging.messaging().isAutoInitEnabled = false; try? await Messaging.messaging().deleteToken() }
    }
    func receivedAPNSToken(_ data: Data) {
        guard configured else { return }
        Messaging.messaging().apnsToken = data
        Task { token = try? await Messaging.messaging().token(); await refresh() }
    }
    func failedAPNSRegistration() { requestedAPNS = false }
    private func removeDelivered(_ category: NotificationCategory) {
        Task {
            let delivered = await UNUserNotificationCenter.current().deliveredNotifications()
            let ids = delivered.filter { $0.request.content.userInfo["category"] as? String == category.rawValue }.map(\.request.identifier)
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
        }
    }
}

/// Keep a coalesced background transition alive until its follow-up sync finishes.
@MainActor private final class PushPresenceBackgroundTask {
    private var identifier = UIBackgroundTaskIdentifier.invalid
    init() {
        identifier = UIApplication.shared.beginBackgroundTask(withName: "Notification presence") { [weak self] in
            Task { @MainActor in self?.end() }
        }
    }
    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier); identifier = .invalid
    }
}
extension PushNotifications: MessagingDelegate {
    nonisolated func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        Task { @MainActor in self.token = fcmToken; await self.refresh() }
    }
}
extension PushNotifications: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [] }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let data = response.notification.request.content.userInfo.reduce(into: [String: String]()) { if let key = $1.key as? String, let value = $1.value as? String { $0[key] = value } }
        guard let route = PushRoute(data: data) else { return }
        await MainActor.run { self.pendingRoute = route }
    }
}

struct NotificationSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(ClientPermissions.self) private var permissions
    @Environment(\.openURL) private var openURL
    @State private var push = PushNotifications.shared
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    category("Chat replies", .chat)
                    category("Task updates", .tasks)
                    category("Brief", .brief)
                    category("Echo reminders", .echo)
                } header: { Text("Notify me about") } footer: { Text("These preferences sync across your devices. Chat and task alerts stay quiet while you're using Impo. Turning off Brief alerts keeps your Brief generation plan.") }
                Section("On this iPhone") {
                    if permissions.notification == .notDetermined {
                        Button("Enable notifications") { Task { await permissions.requestNotifications(); await push.refresh() } }
                    } else {
                        Text(push.permissionAllowed ? "Notifications are allowed" : "Notifications are off in iPhone Settings")
                        Button("Open notification settings") { if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) } }
                    }
                }
                if let error = push.error { Section { Text(error); Button("Retry") { Task { await push.refresh() } } } }
            }
            .scrollContentBackground(.hidden).background(InstantStyle.paper).tint(InstantStyle.forest)
            .navigationTitle("Notifications").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await permissions.refreshStatus(); await push.refresh() }
        }
    }
    private func category(_ title: String, _ category: NotificationCategory) -> some View {
        Toggle(title, isOn: Binding(get: { push.preferences[category] }, set: { push.set(category, enabled: $0) }))
            .disabled(!push.loaded).accessibilityIdentifier("notifications.\(category.rawValue)")
    }
}
