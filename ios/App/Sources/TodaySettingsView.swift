import SwiftUI
import InstantClient


struct TodaySettingsView: View {
    @Environment(TodayModel.self) private var today
    @Environment(\.dismiss) private var dismiss
    @State private var slots: [TodaySlot] = []
    @State private var content = TodayContentPreferences()
    @State private var busy = false
    @State private var error: String?
    @Environment(ClientPermissions.self) private var permissions
    @Environment(\.openURL) private var openURL
    @State private var showManualCity = false
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach([("suggestion", "Next steps"), ("recap", "Useful updates"), ("connect", "Connection suggestions"), ("feature", "Feature tips"), ("occasion", "Occasion greetings")], id: \.0) { key, label in
                        Toggle(label, isOn: Binding(get: { content.categories[key] ?? true }, set: { content.categories[key] = $0 }))
                            .accessibilityIdentifier("today.category.\(key)")
                    }
                    if content.categories["occasion"] != false {
                        Picker("Occasion calendar", selection: $content.occasionCalendar) {
                            Text("None").tag("none")
                            Text("New Year").tag("gregorian")
                            Text("New Year and Mid-Autumn").tag("chinese")
                        }
                    }
                    Button("Restore hidden suggestions") {
                        Task { busy = true; defer { busy = false }; do { try await today.resetSuggestions() } catch { self.error = error.localizedDescription } }
                    }.disabled(busy || !today.isLive)
                } header: { Text("What appears in Brief") } footer: { Text("Choose useful next steps, updates and tips. Push notifications are controlled separately in Notifications. Mid-Autumn dates are verified through 2027.") }
                Section {
                    ForEach($slots) { $slot in
                        VStack(alignment: .leading, spacing: 8) {
                            Toggle(slot.label, isOn: $slot.enabled)
                            if slot.enabled {
                                Picker("After", selection: $slot.hour) {
                                    ForEach(0..<24, id: \.self) { hour in Text(String(format: "%02d:00", hour)).tag(hour) }
                                }
                            }
                        }
                    }
                } header: { Text("Briefs throughout your day") } footer: { Text("Briefs arrive after an hourly check. Each one stays in your timeline.") }
                Section {
                    LabeledContent("Time zone", value: today.settings?.timeZone ?? TimeZone.current.identifier)
                    LabeledContent("Language", value: Locale.current.localizedString(forIdentifier: today.settings?.locale ?? Locale.current.identifier) ?? Locale.current.identifier)
                    Text("Language and time zone follow your iPhone settings.").font(.caption).foregroundStyle(.secondary)
                    if let location = today.settings?.location {
                        LabeledContent(location.source == .manual ? "Chosen city" : "Current city", value: location.city)
                            .accessibilityElement(children: .combine).accessibilityIdentifier("today.city")
                        Text(location.source == .manual ? "Chosen by you. Kept until you change it." : "Updates automatically while you use Impo.").font(.caption).foregroundStyle(.secondary)
                    }
                    if permissions.cityPermission == .authorized {
                        Button("Refresh current city") { Task { await permissions.activate(context: today, forceCity: true, offerCityFallback: false); if permissions.canChooseCity { showManualCity = true } } }
                            .disabled(permissions.updatingCity || !today.isLive).accessibilityIdentifier("today.use-city")
                    } else if permissions.cityPermission == .notDetermined {
                        Button("Enable automatic location") { Task { await permissions.activate(context: today, forceCity: true, offerCityFallback: false); if permissions.canChooseCity { showManualCity = true } } }
                            .disabled(permissions.updatingCity || !today.isLive).accessibilityIdentifier("today.use-city")
                    } else if permissions.cityPermission == .denied {
                        Button("Enable location in Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) } }
                    } else { Text("Location is restricted on this iPhone.").font(.caption) }
                    if permissions.canChooseCity {
                        Button(today.settings?.location?.source == .manual ? "Change chosen city" : "Choose a city") { showManualCity = true }
                            .disabled(!today.isLive).accessibilityIdentifier("today.choose-city")
                    }
                    if let error = permissions.cityError { Text(error).font(.caption).foregroundStyle(.secondary) }
                    if permissions.updatingCity { ProgressView("Updating your city…") }
                    if today.settings?.location?.source == .manual {
                        Button("Remove chosen city", role: .destructive) {
                            Task { busy = true; do { try await today.save(clearLocation: true) } catch { self.error = error.localizedDescription }; busy = false }
                        }.disabled(busy)
                    }
                } header: { Text("Your context") } footer: { Text("Brief uses your city while the app is open. Echo can separately attach nearby places while recording, including with the screen locked. Coordinates stay on your iPhone.") }
                if busy { ProgressView() }
                if let error { Text(error).foregroundStyle(.red) }
            }.navigationTitle("Brief preferences").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { Task { busy = true; do { try await today.save(slots: slots, contentPreferences: content); dismiss() } catch { self.error = error.localizedDescription; busy = false } } }
                            .disabled(busy || slots.isEmpty || !today.isLive).accessibilityIdentifier("today.settings-save")
                    }
                }
        }.onAppear { slots = today.settings?.slots ?? []; content = today.settings?.contentPreferences ?? TodayContentPreferences() }
            .task { await permissions.refreshStatus() }
            .sheet(isPresented: $showManualCity) { ManualCityView().swipeToDismiss() }
    }
}
