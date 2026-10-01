import SwiftUI
import InstantClient

struct EchoScheduleView: View {
    @Environment(ListeningModel.self) private var listening
    @Environment(ClientPermissions.self) private var permissions
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var draft = EchoSchedule(timeZone: TimeZone.current.identifier)
    @State private var ready = false
    @State private var loading = true
    @State private var error: String?
    @State private var push = PushNotifications.shared
    private let days = [(1, "Monday"), (2, "Tuesday"), (3, "Wednesday"), (4, "Thursday"), (5, "Friday"), (6, "Saturday"), (7, "Sunday")]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Enable Echo schedule", isOn: $draft.enabled).accessibilityIdentifier("echo.schedule.enabled")
                    Text("A little nudge to capture your day. You'll choose when to start recording.").foregroundStyle(InstantStyle.muted)
                }
                Section("Repeat") {
                    ForEach(days, id: \.0) { day, name in
                        Toggle(name, isOn: Binding(get: { draft.weekdays.contains(day) }, set: { enabled in
                            draft.weekdays.removeAll { $0 == day }; if enabled { draft.weekdays.append(day); draft.weekdays.sort() }
                        })).accessibilityIdentifier("echo.schedule.day.\(day)")
                    }
                    if draft.weekdays.isEmpty { Text("Choose at least one day.").foregroundStyle(.red) }
                }
                Section {
                    DatePicker("Remind me to start", selection: time(\.reminderTime), displayedComponents: .hourAndMinute).accessibilityIdentifier("echo.schedule.reminder")
                    Toggle("Stop Echo automatically", isOn: $draft.autoStop).accessibilityIdentifier("echo.schedule.auto-stop")
                    if draft.autoStop {
                        DatePicker("Stop at", selection: time(\.stopTime), displayedComponents: .hourAndMinute).accessibilityIdentifier("echo.schedule.stop")
                    }
                    if draft.autoStop && draft.stopTime <= draft.reminderTime { Text("Choose a stop time after the reminder.").foregroundStyle(.red) }
                } header: { Text("Times") } footer: {
                    Text("Reminders open Echo without starting the microphone. Automatic stop ends any Echo recording at the next stop time on a selected day, including while your iPhone is locked. You can always stop sooner.")
                }
                Section("Time zone") {
                    LabeledContent("Schedule time zone", value: draft.timeZone.replacingOccurrences(of: "_", with: " "))
                    Button("Use this iPhone's time zone") { draft.timeZone = TimeZone.current.identifier }
                    Text("The schedule stays in this time zone when you travel.").font(.footnote).foregroundStyle(InstantStyle.muted)
                }
                if !push.preferences.echo { Section { Text("Echo reminders are off in Notifications. Your automatic stop time still applies.") } }
                if permissions.notificationNeedsAttention {
                    Section("Notifications") {
                        Text("Allow notifications on this iPhone to receive Echo reminders.")
                        if permissions.notification == .notDetermined {
                            Button("Enable notifications") { Task { await permissions.requestNotifications(); await push.refresh() } }
                        } else {
                            Button("Open notification settings") { if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) } }
                        }
                    }
                }
                if let error = error ?? listening.echoScheduleError {
                    Section { Text(error).foregroundStyle(.red); Button("Reload schedule") { Task { await load() } } }
                }
                if loading { ProgressView("Loading your schedule…") }
            }
            .disabled(listening.echoScheduleSaving)
            .scrollContentBackground(.hidden).background(InstantStyle.paper)
            .environment(\.timeZone, TimeZone(identifier: draft.timeZone) ?? .current)
            .navigationTitle("Echo schedule").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(listening.echoScheduleSaving ? "Saving…" : "Save") { Task {
                        do { try await listening.saveEchoSchedule(draft); dismiss() }
                        catch let api as InstantAPIError where api.code == "echo_schedule_changed" { error = "Your schedule changed on another device. Reload it before saving." }
                        catch { self.error = "Couldn't save your schedule. Please try again." }
                    } }.disabled(!ready || !draft.isValid || listening.echoScheduleSaving).accessibilityIdentifier("echo.schedule.save")
                }
            }
        }.tint(InstantStyle.forest)
            .task { await load(); await permissions.refreshStatus(); await push.refresh() }
            .onChange(of: listening.echoScheduleLoaded) { _, loaded in
                if loaded && !ready { draft = listening.echoSchedule; if draft.revision == nil { draft.timeZone = TimeZone.current.identifier }; ready = true }
            }
    }
    private func load() async {
        loading = true; defer { loading = false }
        error = nil; await listening.refreshEchoSchedule(force: true)
        draft = listening.echoSchedule
        if draft.revision == nil { draft.timeZone = TimeZone.current.identifier }
        ready = listening.echoScheduleLoaded
    }
    private func time(_ key: WritableKeyPath<EchoSchedule, String>) -> Binding<Date> {
        Binding(get: {
            var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: draft.timeZone) ?? .current
            let parts = draft[keyPath: key].split(separator: ":").compactMap { Int($0) }
            return calendar.date(from: DateComponents(year: 2000, month: 1, day: 1, hour: parts[0], minute: parts[1])) ?? Date()
        }, set: { date in
            let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(identifier: draft.timeZone); formatter.dateFormat = "HH:mm"
            draft[keyPath: key] = formatter.string(from: date)
        })
    }
}
