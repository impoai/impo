import SwiftUI
import InstantClient

struct NotificationPermissionButton: View {
    @Environment(ClientPermissions.self) private var permissions
    var body: some View {
        if permissions.notificationNeedsAttention {
            Button { permissions.showNotifications() } label: {
                Image(systemName: "bell.slash").font(.system(size: 17))
                    .foregroundStyle(InstantStyle.forest).frame(width: 44, height: 44)
                    .overlay(alignment: .topTrailing) { Circle().fill(InstantStyle.accent).frame(width: 6, height: 6).padding(9) }
            }.accessibilityLabel("Notifications are off")
                .accessibilityHint("View notification permissions")
                .accessibilityIdentifier("permissions.notifications")
        }
    }
}

struct NotificationPermissionView: View {
    @Environment(ClientPermissions.self) private var permissions
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Image(systemName: permissions.notificationNeedsAttention ? "bell.slash" : "bell.badge")
                        .font(.system(size: 34, weight: .light)).foregroundStyle(InstantStyle.forest)
                    Text(permissions.notification == .denied ? "Notifications are off" : "A place for your updates")
                        .font(InstantStyle.serif(30))
                    Text(permissions.notification == .denied
                         ? "Open iPhone Settings, choose Notifications, and turn on Allow Notifications for Impo. You can choose sounds, badges, and where alerts appear."
                         : "Allow Impo to show notifications on your iPhone. You can change how they appear at any time in Settings.")
                        .font(.body).foregroundStyle(InstantStyle.muted).fixedSize(horizontal: false, vertical: true)
                    if permissions.notification == .notDetermined {
                        PillButton(title: "Enable notifications") { Task { await permissions.requestNotifications() } }
                            .disabled(permissions.requestingNotifications).accessibilityIdentifier("permissions.enable-notifications")
                    } else if permissions.notification == .denied {
                        PillButton(title: "Open notification settings") {
                            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                        }.accessibilityIdentifier("permissions.notification-settings")
                    } else if permissions.notification != nil {
                        Label("Notifications are allowed", systemImage: "checkmark.circle").foregroundStyle(InstantStyle.forest)
                    }
                    if let error = permissions.notificationError { Text(error).foregroundStyle(.red) }
                    Button("Not now") { dismiss() }.foregroundStyle(InstantStyle.muted).frame(minHeight: 44)
                        .accessibilityIdentifier("permissions.not-now")
                }.padding(26)
            }.background(InstantStyle.paper).navigationTitle("Notifications").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.task { await permissions.refreshStatus() }
    }
}

struct ManualCityView: View {
    @Environment(TodayModel.self) private var today
    @Environment(ClientPermissions.self) private var permissions
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var city = ""
    @State private var country = ""
    @State private var saving = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(permissions.cityPermission == .restricted
                         ? "Location access is restricted on this iPhone. You can choose a city for your briefs instead."
                         : "Without location access, choose the city you'd like Impo to use for your briefs.")
                        .foregroundStyle(.secondary)
                    TextField("City", text: $city).textContentType(.addressCity).accessibilityIdentifier("permissions.city-field")
                    TextField("Country or region", text: $country).textContentType(.countryName).accessibilityIdentifier("permissions.country-field")
                } header: { Text("Your city") } footer: { Text("This choice stays until you change it or enable automatic location. It doesn't tell Impo where you are right now.") }
                if permissions.cityPermission != .restricted {
                    Section {
                        Button("Open location settings") { if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) } }
                    }
                }
                if let error { Text(error).foregroundStyle(.red) }
            }.navigationTitle("Choose a city").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Not now") { dismiss() }.accessibilityIdentifier("permissions.skip-city") }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { Task {
                            saving = true; error = nil
                            do {
                                try await today.save(location: TodayLocation(city: city.trimmingCharacters(in: .whitespacesAndNewlines), country: country.trimmingCharacters(in: .whitespacesAndNewlines), capturedAt: ISO8601DateFormatter().string(from: Date()), source: .manual))
                                ListeningDiagnostics.shared.record("permissions.city_synced", ["phase": "manual"])
                                dismiss()
                            } catch { self.error = "Couldn't save your city. Check your connection and try again." }
                            saving = false
                        } }.disabled(saving || !today.isLive || city.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || city.count > 100 || country.count > 100)
                            .accessibilityIdentifier("permissions.save-city")
                    }
                }
        }.onAppear { city = today.settings?.location?.city ?? ""; country = today.settings?.location?.country ?? "" }
    }
}
