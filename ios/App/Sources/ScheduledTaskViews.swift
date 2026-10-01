import SwiftUI
import InstantClient

struct ScheduledTaskRoute: Identifiable {
    let id = UUID()
    var value: ScheduledTask?
}

private func scheduleDate(_ value: String?) -> Date? {
    guard let value else { return nil }
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}
private func scheduleDateLabel(_ value: String?, zone: String) -> String {
    guard let date = scheduleDate(value) else { return "No upcoming run" }
    let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US")
    formatter.timeZone = TimeZone(identifier: zone); formatter.dateStyle = .medium; formatter.timeStyle = .short
    return formatter.string(from: date)
}

struct ScheduledTasksList: View {
    @Environment(TasksModel.self) private var tasks
    let open: (ScheduledTask?) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Make time for what matters").font(InstantStyle.serif(26))
            Text("Give a task a time. Impo takes it from there, even when the app is closed.")
                .foregroundStyle(InstantStyle.muted)
            Button { open(nil) } label: { Label("Schedule a task", systemImage: "plus").frame(minHeight: 44) }
                .accessibilityIdentifier("schedule.new")
            if tasks.schedulesLoading { ProgressView("Loading schedules…") }
            if let error = tasks.scheduleError { Text(error).font(.footnote).foregroundStyle(InstantStyle.muted) }
            ForEach(tasks.schedules) { value in
                Button { open(value) } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(value.title).font(.system(size: 19, weight: .medium)).foregroundStyle(InstantStyle.ink)
                            Spacer()
                            Image(systemName: value.enabled ? "clock" : "pause.circle").foregroundStyle(InstantStyle.forest)
                        }
                        Text(value.enabled ? (value.nextRunAt == nil ? "Completed" : "Next: \(scheduleDateLabel(value.nextRunAt, zone: value.schedule.timeZone))") : "Paused")
                            .font(.subheadline).foregroundStyle(InstantStyle.muted)
                        Text("\(value.schedule.frequency.capitalized) · \(value.schedule.timeZone)")
                            .font(.caption).foregroundStyle(InstantStyle.muted)
                    }.multilineTextAlignment(.leading).padding(20).frame(maxWidth: .infinity, alignment: .leading).paperSurface(cornerRadius: 24)
                }.buttonStyle(PressStyle()).accessibilityIdentifier("schedule.\(value.id)")
            }
        }.tint(InstantStyle.forest)
    }
}

struct ScheduledTaskEditor: View {
    @Environment(AppModel.self) private var app
    @Environment(TasksModel.self) private var tasks
    @Environment(\.dismiss) private var dismiss
    let initial: ScheduledTask?
    @State private var source: ScheduledTask?
    @State private var title = ""
    @State private var goal = ""
    @State private var frequency = "daily"
    @State private var zone = TimeZone.current.identifier
    @State private var date = Date().addingTimeInterval(3600)
    @State private var days: Set<Int> = [1, 2, 3, 4, 5]
    @State private var enabled = true
    @State private var ready = false
    @State private var saving = false
    @State private var error: String?
    @State private var deleting = false
    @State private var requestId = UUID().uuidString
    @State private var pending: ScheduledTaskInput?
    @State private var runs: [ScheduledTaskRun] = []
    @State private var cursor: String?
    @State private var historyError: String?
    @State private var loadingHistory = false
    @State private var runRoute: TaskRoute?
    private let dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

    private var input: ScheduledTaskInput {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: zone); formatter.dateFormat = "HH:mm"
        return .init(title: title.trimmingCharacters(in: .whitespacesAndNewlines), goal: goal.trimmingCharacters(in: .whitespacesAndNewlines),
                     schedule: .init(frequency: frequency, timeZone: zone, runAt: frequency == "once" ? ISO8601DateFormatter().string(from: date) : nil,
                                     time: frequency == "once" ? nil : formatter.string(from: date), weekdays: frequency == "weekly" ? days.sorted() : []), enabled: enabled)
    }
    private var valid: Bool {
        !input.title.isEmpty && input.title.utf16.count <= 120 && !input.goal.isEmpty && input.goal.utf16.count <= 4000
        && TimeZone(identifier: zone) != nil && (frequency != "weekly" || !days.isEmpty)
        && (!enabled || frequency != "once" || date > Date() || input == source?.input)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("The task") {
                    TextField("A short title", text: $title).accessibilityIdentifier("schedule.title")
                    TextField("What should Impo do?", text: $goal, axis: .vertical).lineLimit(4...10).accessibilityIdentifier("schedule.goal")
                    Text("Include the details each run will need. Each result gets its own task conversation.").font(.footnote).foregroundStyle(InstantStyle.muted)
                }.disabled(saving || pending != nil)
                Section {
                    Picker("Repeat", selection: $frequency) { Text("Once").tag("once"); Text("Every day").tag("daily"); Text("Every week").tag("weekly") }
                        .accessibilityIdentifier("schedule.frequency")
                    DatePicker(frequency == "once" ? "Run at" : "Time", selection: $date,
                               displayedComponents: frequency == "once" ? [.date, .hourAndMinute] : [.hourAndMinute])
                    if frequency == "weekly" {
                        ForEach(1...7, id: \.self) { day in
                            Toggle(dayNames[day - 1], isOn: Binding(get: { days.contains(day) }, set: { if $0 { days.insert(day) } else { days.remove(day) } }))
                        }
                        if days.isEmpty { Text("Choose at least one day.").foregroundStyle(.red) }
                    }
                    NavigationLink { ScheduleTimeZones(selected: $zone) } label: { LabeledContent("Time zone", value: zone.replacingOccurrences(of: "_", with: " ")) }
                    Toggle("Schedule enabled", isOn: $enabled).accessibilityIdentifier("schedule.enabled")
                } header: { Text("Schedule") } footer: { Text("The schedule keeps this time zone when you travel. If a run is still working, the next occurrence is skipped.") }
                    .disabled(saving || pending != nil)
                if let source {
                    Section("Next run") { Text(source.enabled ? scheduleDateLabel(source.nextRunAt, zone: source.schedule.timeZone) : "Paused") }
                    history
                    Section {
                        Button("Delete schedule", role: .destructive) { deleting = true }.disabled(saving).accessibilityIdentifier("schedule.delete")
                        Text("Pausing or deleting stops future runs. Tasks already started keep their results.").font(.footnote).foregroundStyle(InstantStyle.muted)
                    }
                }
                Section { Text("Control completion alerts in Settings → Notifications → Scheduled tasks.").font(.footnote).foregroundStyle(InstantStyle.muted) }
                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                        if source != nil && pending == nil { Button("Reload schedule") { Task { await reload() } }.disabled(saving) }
                    }
                }
                if !ready { ProgressView("Loading schedule…") }
            }
            .scrollContentBackground(.hidden).background(InstantStyle.paper)
            .environment(\.timeZone, TimeZone(identifier: zone) ?? .current)
            .navigationTitle(initial == nil ? "Schedule a task" : "Scheduled task").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : pending == nil ? "Save" : "Retry save") { Task { await save() } }
                        .disabled(!ready || saving || (!valid && pending == nil)).accessibilityIdentifier("schedule.save")
                }
            }
            .confirmationDialog("Delete this schedule?", isPresented: $deleting, titleVisibility: .visible) {
                Button("Delete schedule", role: .destructive) { Task { await remove() } }
            } message: { Text("Future runs will stop. Existing task results will stay in Tasks.") }
            .fullScreenCover(item: $runRoute) { route in
                if case .detail(let id) = route { TaskDetailView(thread: tasks.thread(for: id, app: app)) }
            }
        }.tint(InstantStyle.forest).interactiveDismissDisabled(saving)
            .task {
                if let initial { source = initial; await reload() }
                else { apply(nil); ready = app.liveClient() != nil; if !ready { error = "Sign in to schedule tasks." } }
            }
    }
    private var history: some View {
        Section("Run history") {
            if runs.isEmpty && !loadingHistory { Text("No runs yet").foregroundStyle(InstantStyle.muted) }
            ForEach(runs) { run in
                Button { if let id = run.taskId { runRoute = .detail(id) } } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(scheduleDateLabel(run.scheduledAt, zone: zone))
                        Text(run.status == "skipped_overlap" ? "Skipped — previous run still working" : run.status.replacingOccurrences(of: "_", with: " ").capitalized)
                            .font(.caption).foregroundStyle(InstantStyle.muted)
                    }
                }.disabled(run.taskId == nil)
            }
            if loadingHistory { ProgressView() }
            if let historyError { Text(historyError).foregroundStyle(.red); Button("Retry history") { Task { await loadHistory(reset: false) } } }
            if cursor != nil { Button("Load earlier runs") { Task { await loadHistory(reset: false) } }.disabled(loadingHistory) }
        }
    }
    private func apply(_ value: ScheduledTask?) {
        title = value?.title ?? ""; goal = value?.goal ?? ""; frequency = value?.schedule.frequency ?? "daily"
        zone = value?.schedule.timeZone ?? TimeZone.current.identifier; enabled = value?.enabled ?? true
        days = Set(value?.schedule.weekdays.isEmpty == false ? value!.schedule.weekdays : [1, 2, 3, 4, 5])
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: zone) ?? .current
        let clock = (value?.schedule.time ?? "09:00").split(separator: ":").compactMap { Int($0) }
        date = scheduleDate(value?.schedule.runAt) ?? calendar.date(bySettingHour: clock.first ?? 9, minute: clock.last ?? 0, second: 0, of: Date().addingTimeInterval(86400))!
    }
    private func reload() async {
        guard let id = source?.id, let api = app.liveClient() else { return }
        let owner = app.listeningScope; ready = false
        do {
            let value = try await api.scheduledTask(id)
            guard !Task.isCancelled, owner == app.listeningScope else { return }
            source = value; apply(value); error = nil; ready = true; await loadHistory(reset: true)
        } catch { if !Task.isCancelled, owner == app.listeningScope { self.error = "Couldn't load this schedule. Close and try again." } }
    }
    private func save() async {
        guard !saving, let api = app.liveClient() else { return }
        let owner = app.listeningScope; saving = true; error = nil
        let value = pending ?? input; pending = value
        defer { saving = false }
        do {
            if let source { _ = try await api.updateScheduledTask(source.id, revision: source.revision, value: value) }
            else { _ = try await api.createScheduledTask(value, clientRequestId: requestId) }
            guard !Task.isCancelled, owner == app.listeningScope else { return }; pending = nil; dismiss()
        } catch {
            guard !Task.isCancelled, owner == app.listeningScope else { return }
            if let apiError = error as? InstantAPIError, (400..<500).contains(apiError.statusCode) {
                pending = nil; requestId = UUID().uuidString
                self.error = apiError.code == "schedule_changed" ? "This schedule changed on another device. Reload before saving." : apiError.message
            } else { self.error = "Couldn't confirm the save. Retry to safely recover the same request." }
        }
    }
    private func remove() async {
        guard !saving, let source, let api = app.liveClient() else { return }
        let owner = app.listeningScope; saving = true; defer { saving = false }
        do { try await api.deleteScheduledTask(source.id, revision: source.revision); if owner == app.listeningScope { dismiss() } }
        catch { if owner == app.listeningScope { self.error = "Couldn't delete this schedule. Reload it and try again." } }
    }
    private func loadHistory(reset: Bool) async {
        guard !loadingHistory, let source, let api = app.liveClient() else { return }
        let owner = app.listeningScope; loadingHistory = true; defer { loadingHistory = false }
        do {
            let page = try await api.scheduledTaskRuns(source.id, before: reset ? nil : cursor)
            guard !Task.isCancelled, owner == app.listeningScope else { return }
            runs = reset ? page.runs : runs + page.runs.filter { incoming in !runs.contains { $0.id == incoming.id } }; cursor = page.nextCursor; historyError = nil
        } catch { if !Task.isCancelled, owner == app.listeningScope { historyError = "Couldn't load run history." } }
    }
}

private struct ScheduleTimeZones: View {
    @Binding var selected: String
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    var body: some View {
        List {
            Button("Use this iPhone's time zone") { selected = TimeZone.current.identifier; dismiss() }
            ForEach(TimeZone.knownTimeZoneIdentifiers.filter { search.isEmpty || $0.localizedCaseInsensitiveContains(search) }, id: \.self) { zone in
                Button { selected = zone; dismiss() } label: { HStack { Text(zone.replacingOccurrences(of: "_", with: " ")); Spacer(); if selected == zone { Image(systemName: "checkmark") } } }
            }
        }.searchable(text: $search).navigationTitle("Time zone").scrollContentBackground(.hidden).background(InstantStyle.paper)
    }
}
