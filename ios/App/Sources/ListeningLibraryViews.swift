import SwiftUI
import InstantClient

struct ListeningTranscriptLibrary: View {
    @Environment(ListeningModel.self) private var listening
    @Environment(AppModel.self) private var app
    @State private var selected: ListeningSegment?
    @State private var showDates = false
    @State private var showSync = false
    @State private var showSchedule = false
    @State private var visibleDate: String?
    @State private var targetDay: String?
    @State private var navigation = UUID()
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = 166
    @ScaledMetric(relativeTo: .title2) private var headerHeight: CGFloat = 62
    private var timeline: EchoTimelineModel { listening.timeline }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button { showDates = true } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "calendar")
                        Text(visibleDate.map { EchoDates.label($0) } ?? "Your days, in echoes.")
                            .font(InstantStyle.serif(19)).lineLimit(1).minimumScaleFactor(0.8)
                        Image(systemName: "chevron.down").font(.caption2)
                    }.frame(minHeight: 44)
                }.accessibilityLabel("Browse Echo by date").accessibilityIdentifier("listening.by-date")
                Spacer(minLength: 0)
                Button { showSchedule = true } label: { Image(systemName: "clock.badge.checkmark").frame(width: 44, height: 44) }
                    .accessibilityLabel("Echo schedule").accessibilityIdentifier("echo.schedule.open")
                if visibleDate != nil && visibleDate != timeline.days.first?.date || targetDay != nil {
                    Button("Latest") { jump(nil) }.font(.subheadline)
                        .accessibilityIdentifier("echo.latest").frame(minHeight: 44)
                }
                Button { showSync = true } label: {
                    Image(systemName: "slider.horizontal.3").frame(width: 44, height: 44)
                }.accessibilityLabel("Echo sync options").accessibilityIdentifier("echo.sync-options")
            }.padding(.leading, 20).padding(.trailing, 8)
            if let stop = listening.scheduledStopAt, listening.isListening {
                Text("Stops \(stop.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption).foregroundStyle(InstantStyle.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.bottom, 8)
            }
            if !listening.pending.isEmpty {
                Button { showSync = true } label: {
                    Label("\(listening.pending.count) saved on this iPhone · waiting to sync", systemImage: "arrow.up.circle")
                        .font(.caption).frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 20).padding(.bottom, 10)
                }
            }
            if let error = timeline.indexError {
                Button { Task { await timeline.refresh() } } label: {
                    Label(error, systemImage: "arrow.clockwise").font(.caption).padding(.horizontal, 20).padding(.bottom, 8)
                }.accessibilityIdentifier("echo.retry-dates")
            }
            ZStack(alignment: .trailing) {
                EchoTimelineList(model: timeline, indexVersion: timeline.indexVersion, contentVersion: timeline.contentVersion,
                                 navigation: navigation, targetDay: targetDay, rowHeight: rowHeight, headerHeight: headerHeight,
                                 visibleDay: { visibleDate = $0 }, select: { selected = $0 })
                if !timeline.days.isEmpty {
                    EchoDateRail(days: timeline.calendar, visibleDate: visibleDate, jump: { jump($0) })
                } else if timeline.loadingIndex && !timeline.loaded {
                    // Only the first load shows a spinner; background refreshes after each
                    // Echo sync keep the current content instead of flashing.
                    ProgressView("Loading your timeline…").frame(maxWidth: .infinity)
                } else if timeline.loaded || !app.useLiveBackend {
                    VStack(alignment: .leading, spacing: 16) {
                        Image(systemName: "waveform").font(.system(size: 34, weight: .light)).foregroundStyle(InstantStyle.accent)
                        Text("Your words, kept in order.").font(InstantStyle.serif(27))
                        Text(app.useLiveBackend ? "Start Echo to keep the conversations and little moments you want to return to." : "Sign in or connect your server in Settings to start Echo.")
                            .font(.body).foregroundStyle(InstantStyle.muted)
                    }.padding(22).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .allowsHitTesting(false).accessibilityIdentifier("listening.library-empty")
                }
            }
        }.foregroundStyle(InstantStyle.ink)
            .task { await timeline.refresh() }
            .fullScreenCover(item: $selected) { ListeningTranscriptDetail(segment: $0).swipeToDismiss() }
            .sheet(isPresented: $showDates) {
                EchoDateBrowser(days: timeline.calendar) { jump($0.isEmpty ? nil : $0) }.swipeToDismiss()
            }
            .sheet(isPresented: $showSync) { EchoSyncSettings().swipeToDismiss() }
            .sheet(isPresented: $showSchedule) { EchoScheduleView().swipeToDismiss() }
    }
    private func jump(_ day: String?) {
        targetDay = day; visibleDate = day ?? timeline.days.first?.date; navigation = UUID()
    }
}

private struct EchoSyncSettings: View {
    @Environment(ListeningModel.self) private var listening
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section("Location") { EchoLocationSettings() }
                Section("Sync") {
                    Toggle("Upload on Wi-Fi only", isOn: Binding(get: { listening.wifiOnly }, set: { listening.wifiOnly = $0 }))
                        .accessibilityIdentifier("listening.wifi-only")
                    Text(listening.uploadStatus).font(.subheadline).foregroundStyle(InstantStyle.muted)
                    if !listening.pending.isEmpty { Text("\(listening.pending.count) speech segments saved on this iPhone") }
                    if let error = listening.uploadError { Text(error).foregroundStyle(InstantStyle.muted) }
                    Button("Sync now") { Task { await listening.sync() } }.accessibilityIdentifier("listening.sync-now")
                }
            }.scrollContentBackground(.hidden).background(InstantStyle.paper)
                .navigationTitle("Echo settings").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.tint(InstantStyle.forest)
    }
}

struct ListeningTranscriptDetail: View {
    let segment: ListeningSegment
    @Environment(ListeningModel.self) private var listening
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingDelete = false
    @State private var editingLocation = false
    @State private var editedSegment: ListeningSegment?
    private var current: ListeningSegment { listening.timeline.records[segment.id] ?? listening.history.first { $0.id == segment.id } ?? editedSegment ?? segment }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(current.recordedAt.formatted(.dateTime.weekday(.wide).month(.wide).day()))
                        .font(InstantStyle.serif(28))
                    Label("\(current.recordedAt.formatted(date: .omitted, time: .shortened)) · \(current.durationLabel)", systemImage: "waveform")
                        .font(.subheadline).foregroundStyle(InstantStyle.muted)
                    Divider()
                    EchoLocationDetail(location: current.location) { editingLocation = true }
                    if current.status == "failed", let batchId = current.batchId {
                        Button("Retry transcription") { Task { await listening.retryBatch(batchId) } }
                    }
                    if let count = current.segmentCount { Text("\(count) speech segment\(count == 1 ? "" : "s") in this batch").font(.caption).foregroundStyle(InstantStyle.muted) }
                    EchoSpeakerTranscript(segment: current) { editedSegment = $0 }
                    if let error = listening.loadError { Text(error).font(.footnote).foregroundStyle(InstantStyle.accent) }
                }.padding(24)
            }.background(InstantStyle.paper).foregroundStyle(InstantStyle.ink)
                .navigationTitle("Echo").navigationBarTitleDisplayMode(.inline)
                .task(id: segment.id) { await listening.refreshRecording(segment.id) }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { Button("Back") { dismiss() }.accessibilityIdentifier("echo.detail-back") }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(role: .destructive) { confirmingDelete = true } label: { Image(systemName: "trash") }
                            .accessibilityLabel("Delete recording").accessibilityIdentifier("listening.delete")
                    }
                }
                .confirmationDialog("Delete this recording and its transcript?", isPresented: $confirmingDelete, titleVisibility: .visible) {
                    Button("Delete recording", role: .destructive) {
                        Task { if await listening.delete(current) { dismiss() } }
                    }
                }
                .sheet(isPresented: $editingLocation) {
                    EchoLocationLabelEditor(segment: current) { editedSegment = $0 }.swipeToDismiss()
                }
        }.tint(InstantStyle.forest)
    }
}

extension ListeningSegment {
    /// Transcribed with nothing said: hidden from Echo lists.
    var isSilent: Bool { status == "transcribed" && transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var recordedAt: Date { Self.parse(startedAt) ?? .distantPast }
    var durationLabel: String {
        let seconds = max(0, audioMilliseconds.map { $0 / 1000 } ?? Int((Self.parse(endedAt) ?? recordedAt).timeIntervalSince(recordedAt)))
        return seconds < 60 ? "\(seconds) sec" : "\(seconds / 60) min \(seconds % 60) sec"
    }
    var displayTranscript: String {
        status == "transcribed" ? (transcript.isEmpty ? "No speech was detected." : transcript)
            : status == "failed" ? "Couldn't transcribe this recording" : status == "pending" ? "Queued for transcription…" : "Transcribing…"
    }
    static func parse(_ value: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value))
            ?? (try? Date.ISO8601FormatStyle().parse(value))
    }
}
