import SwiftUI
import UserNotifications
import InstantClient
import CryptoKit

// Permission state comes from iOS, never from a persisted "enabled" toggle.
enum NotificationPermission: Equatable { case notDetermined, denied, authorized, provisional, ephemeral }
enum CityPermission: Equatable { case notDetermined, denied, restricted, authorized }
enum PermissionPresentation: String, Identifiable { case notifications, city; var id: String { rawValue } }

@MainActor protocol NotificationPermissionReading {
    func status() async -> NotificationPermission
    func request() async throws
}
@MainActor final class SystemNotificationPermission: NotificationPermissionReading {
    func status() async -> NotificationPermission {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized: .authorized
        case .provisional: .provisional
        case .ephemeral: .ephemeral
        case .denied: .denied
        default: .notDetermined
        }
    }
    func request() async throws { _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) }
}
@MainActor protocol CityPermissionReading {
    var authorization: CityPermission { get }
    func read(requestPermission: Bool) async throws -> TodayLocation
    func cancel()
}
@MainActor protocol PermissionContext: AnyObject {
    var isLive: Bool { get }
    var contextID: UUID { get }
    var location: TodayLocation? { get }
    func updateLocation(_ location: TodayLocation?, clear: Bool) async throws
}

@MainActor @Observable final class ClientPermissions {
    var notification: NotificationPermission?
    var cityPermission: CityPermission = .notDetermined
    var presentation: PermissionPresentation?
    var cityError: String?
    var notificationError: String?
    var updatingCity = false
    var requestingNotifications = false
    var notificationNeedsAttention: Bool { notification == .notDetermined || notification == .denied }
    var canChooseCity: Bool { cityPermission == .denied || cityPermission == .restricted || cityError != nil || (cityPermission == .notDetermined && defaults.bool(forKey: locationAskedKey)) }
    @ObservationIgnored private let notifications: any NotificationPermissionReading
    @ObservationIgnored private let city: any CityPermissionReading
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var operation: UUID?
    @ObservationIgnored private var scope: String?
    @ObservationIgnored private var lastAttempt: Date?
    @ObservationIgnored private var fallbackOffered = false
    @ObservationIgnored private var inToday = false
    @ObservationIgnored private var liveContext = false
    private let locationAskedKey = "impo.permissions.locationAsked"
    private let notificationsOfferedKey = "impo.permissions.notificationsOffered"

    init(notifications: any NotificationPermissionReading = SystemNotificationPermission(), city: any CityPermissionReading = TodayCityReader(), defaults: UserDefaults = .standard) {
        self.notifications = notifications; self.city = city; self.defaults = defaults
    }
    func configure(scope: String?) {
        guard scope != self.scope else { return }
        self.scope = scope; operation = nil; city.cancel(); updatingCity = false; lastAttempt = nil
        cityError = nil; presentation = nil; fallbackOffered = defaults.bool(forKey: fallbackKey); liveContext = scope != nil
    }
    func refreshStatus() async {
        notification = await notifications.status()
        cityPermission = city.authorization
    }
    func enteredToday(_ entered: Bool) {
        inToday = entered
        offerNotificationsIfNeeded()
    }
    func offerNotificationsIfNeeded() {
        guard inToday, liveContext, !updatingCity, presentation == nil, notification == .notDetermined,
              !defaults.bool(forKey: notificationsOfferedKey) else { return }
        showNotifications()
    }
    func showNotifications() {
        defaults.set(true, forKey: notificationsOfferedKey)
        notificationError = nil; presentation = .notifications
    }
    func requestNotifications() async {
        guard !requestingNotifications else { return }
        requestingNotifications = true; defer { requestingNotifications = false }
        await refreshStatus()
        guard notification == .notDetermined else { return }
        do { try await notifications.request() }
        catch { notificationError = "Couldn't request notifications. Please try again." }
        await refreshStatus()
        ListeningDiagnostics.shared.record("permissions.notifications", ["status": String(describing: notification)])
        if !notificationNeedsAttention { presentation = nil }
    }
    func activate(context: any PermissionContext, forceCity: Bool = false, offerCityFallback: Bool = true) async {
        await refreshStatus()
        guard context.isLive, operation == nil, !Task.isCancelled else { return }
        let identity = context.contextID
        let id = UUID(); operation = id; updatingCity = true
        defer {
            if operation == id { operation = nil; updatingCity = false; offerNotificationsIfNeeded() }
        }
        let existing = context.location
        // Revoking location removes the device snapshot, but preserves an explicitly chosen city.
        if cityPermission == .denied || cityPermission == .restricted {
            if existing != nil && existing?.source != .manual {
                do { try await context.updateLocation(nil, clear: true) }
                catch { cityError = "Couldn't remove your previous city. We'll try again when you're connected." }
            }
            guard context.contextID == identity, operation == id else { return }
            if offerCityFallback, context.location == nil { offerCityFallbackIfNeeded() }
            return
        }
        if cityPermission == .notDetermined {
            // Allow Once can return to notDetermined. Do not prompt again on every launch.
            guard forceCity || !defaults.bool(forKey: locationAskedKey) else { return }
            defaults.set(true, forKey: locationAskedKey)
        } else if !forceCity {
            if let lastAttempt, Date().timeIntervalSince(lastAttempt) < 60 { return }
            if let existing, existing.source != .manual, let captured = Self.date(existing.capturedAt), Date().timeIntervalSince(captured) < 3600 { return }
        }
        lastAttempt = Date(); cityError = nil
        do {
            let location = try await city.read(requestPermission: cityPermission == .notDetermined)
            guard context.contextID == identity, operation == id, !Task.isCancelled else { return }
            try await context.updateLocation(location, clear: false)
            ListeningDiagnostics.shared.record("permissions.city_synced", ["phase": "device"])
        } catch {
            guard context.contextID == identity, operation == id, !Task.isCancelled, !(error is CancellationError) else { return }
            cityPermission = city.authorization
            if cityPermission == .denied || cityPermission == .restricted {
                if context.location != nil && context.location?.source != .manual { try? await context.updateLocation(nil, clear: true) }
                if offerCityFallback, context.contextID == identity, context.location == nil { offerCityFallbackIfNeeded() }
            } else {
                cityError = "Couldn't update your city. You can retry or choose one below."
                ListeningDiagnostics.shared.error("permissions.city_failed", error)
            }
        }
        if operation == id { cityPermission = city.authorization }
    }
    private var fallbackKey: String {
        let digest = SHA256.hash(data: Data((scope ?? "").utf8)).map { String(format: "%02x", $0) }.joined()
        return "impo.permissions.cityFallbackOffered." + digest
    }
    private func offerCityFallbackIfNeeded() {
        guard !fallbackOffered, presentation == nil else { return }
        fallbackOffered = true; defaults.set(true, forKey: fallbackKey); presentation = .city
    }
    private static func date(_ raw: String) -> Date? {
        let parser = ISO8601DateFormatter()
        if let date = parser.date(from: raw) { return date }
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return parser.date(from: raw)
    }
}

extension TodayModel: PermissionContext {
    var location: TodayLocation? { settings?.location }
    func updateLocation(_ location: TodayLocation?, clear: Bool) async throws { try await save(location: location, clearLocation: clear) }
}
