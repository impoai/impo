import SwiftUI
import InstantClient

struct ListeningLibraryScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(ListeningModel.self) private var listening
    var body: some View {
        NavigationStack {
            ListeningTranscriptLibrary()
                .background(InstantStyle.paper).navigationTitle("Echo")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .principal) { Text("Echo").font(InstantStyle.serif(25)).foregroundStyle(InstantStyle.ink) }
                    ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
                }
                .safeAreaInset(edge: .top) {
                    if listening.isListening { ListeningStatusView().padding(.horizontal, 16).padding(.bottom, 8) }
                }
        }.tint(InstantStyle.forest)
    }
}

private enum EchoLoadIntent { case latest, day(String), older, newer }
private struct EchoLibraryRow: Identifiable {
    let segment: ListeningSegment
    let startsDay: Bool
    var id: String { segment.id }
}

struct ListeningTranscriptLibrary: View {
    @Environment(ListeningModel.self) private var listening
    @Environment(AppModel.self) private var app
    @State private var selected: ListeningSegment?
    @State private var showDates = false
    @State private var showSync = false
    @State private var visibleID: String?
    @State private var userScrolling = false
    @State private var retryIntent = EchoLoadIntent.latest
    private var rows: [EchoLibraryRow] {
        var previous = ""
        // Recordings where no speech was found are not worth a row.
        return listening.history.filter { !$0.isSilent }.map { segment in
            let day = EchoDates.key(segment.recordedAt), starts = previous != day
            previous = day
            return EchoLibraryRow(segment: segment, startsDay: starts)
        }
    }
    private var visibleDate: String? {
        listening.history.first { $0.id == visibleID }.map { EchoDates.key($0.recordedAt) }
            ?? listening.history.first.map { EchoDates.key($0.recordedAt) }
    }
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
                if listening.historyNewerCursor != nil || listening.historyBrowsingDate != nil {
                    Button("Latest") { Task { await perform(.latest) } }.font(.subheadline)
                        .accessibilityIdentifier("echo.latest").frame(minHeight: 44)
                }
                Button { showSync = true } label: {
                    Image(systemName: "slider.horizontal.3").frame(width: 44, height: 44)
                }.accessibilityLabel("Echo sync options").accessibilityIdentifier("echo.sync-options")
            }.padding(.leading, 20).padding(.trailing, 8)
            if !listening.pending.isEmpty {
                Button { showSync = true } label: {
                    Label("\(listening.pending.count) saved on this iPhone · waiting to sync", systemImage: "arrow.up.circle")
                        .font(.caption).frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 20).padding(.bottom, 10)
                }
            }
            if let error = listening.historyCalendarError {
                Button { Task { await listening.refreshHistoryCalendar() } } label: {
                    Label(error, systemImage: "calendar.badge.exclamationmark").font(.caption).padding(.horizontal, 20).padding(.bottom, 8)
                }.accessibilityIdentifier("echo.retry-dates")
            }
            ZStack(alignment: .trailing) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if listening.historyNewerCursor != nil {
                            Button { Task { await perform(.newer) } } label: {
                                Label("Newer recordings", systemImage: "arrow.up").font(.subheadline).frame(maxWidth: .infinity, minHeight: 48)
                            }.accessibilityIdentifier("echo.load-newer")
                        }
                        if rows.isEmpty && !listening.historyLoading {
                            VStack(alignment: .leading, spacing: 16) {
                                Image(systemName: "waveform").font(.system(size: 34, weight: .light)).foregroundStyle(InstantStyle.accent)
                                Text("Your words, kept in order.").font(InstantStyle.serif(27))
                                Text(app.useLiveBackend ? "Start Echo to keep the conversations and little moments you want to return to." : "Sign in or connect your server in Settings to start Echo.")
                                    .font(.body).foregroundStyle(InstantStyle.muted)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 28)
                                .accessibilityIdentifier("listening.library-empty")
                        }
                        ForEach(rows) { row in
                            VStack(alignment: .leading, spacing: 0) {
                                if row.startsDay {
                                    Text(row.segment.recordedAt.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()))
                                        .font(InstantStyle.serif(23)).padding(.top, 22).padding(.bottom, 12)
                                }
                                Button { selected = row.segment } label: { transcriptRow(row.segment) }
                                    .buttonStyle(.plain).accessibilityIdentifier("listening.recording.\(row.id)")
                                Divider().overlay(InstantStyle.border.opacity(0.6)).padding(.vertical, 12)
                            }.id(row.id)
                                .onAppear {
                                    if row.id == rows.suffix(6).first?.id, listening.historyError == nil {
                                        Task { await perform(.older) }
                                    }
                                }
                        }
                        if let error = listening.historyError {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(error).font(.subheadline).foregroundStyle(InstantStyle.muted)
                                Button("Try again") { Task { await perform(retryIntent) } }
                                    .accessibilityIdentifier("echo.retry-page")
                            }.padding(.vertical, 20)
                        }
                        if listening.historyLoading { ProgressView().frame(maxWidth: .infinity).padding(20) }
                        else if listening.historyCursor != nil {
                            Button("Show more") { Task { await perform(.older) } }
                                .font(.subheadline).frame(maxWidth: .infinity, minHeight: 44)
                                .accessibilityIdentifier("listening.load-more")
                        } else if !rows.isEmpty {
                            Text("The beginning of your Echo.").font(InstantStyle.serif(17, italic: true))
                                .foregroundStyle(InstantStyle.muted).padding(.vertical, 24)
                        }
                    }.scrollTargetLayout().padding(.leading, 22)
                        .padding(.trailing, listening.historyDays.isEmpty ? 22 : 84).padding(.bottom, 22)
                }.scrollIndicators(.hidden).scrollPosition(id: $visibleID, anchor: .top)
                    .onScrollPhaseChange { _, phase in userScrolling = phase == .interacting || phase == .decelerating }
                    .onScrollGeometryChange(for: Bool.self, of: { $0.contentOffset.y < 100 && $0.contentOffset.y >= 0 }) { _, nearTop in
                        if nearTop, userScrolling, listening.historyNewerCursor != nil, listening.historyError == nil {
                            Task { await perform(.newer) }
                        }
                    }
                    .refreshable { await listening.refreshHistory(); await listening.refreshHistoryCalendar() }
                    .accessibilityIdentifier("echo.timeline")
                if !listening.historyDays.isEmpty {
                    EchoDateRail(days: listening.historyDays, visibleDate: visibleDate) { day in Task { await perform(.day(day)) } }
                }
            }
        }.foregroundStyle(InstantStyle.ink)
            .task {
                await listening.refreshHistory()
                await listening.refreshHistoryCalendar()
            }
            .onChange(of: listening.historyNavigationID) { _, _ in visibleID = listening.history.first?.id }
            .fullScreenCover(item: $selected) { ListeningTranscriptDetail(segment: $0).swipeToDismiss() }
            .sheet(isPresented: $showDates) {
                EchoDateBrowser(days: listening.historyDays) { day in Task { await perform(day.isEmpty ? .latest : .day(day)) } }.swipeToDismiss()
            }
            .sheet(isPresented: $showSync) { EchoSyncSettings().swipeToDismiss() }
    }
    private func perform(_ intent: EchoLoadIntent) async {
        retryIntent = intent
        switch intent {
        case .latest: await listening.jumpHistory(); await listening.refreshHistoryCalendar()
        case .day(let day): await listening.jumpHistory(to: day)
        case .older: await listening.loadMoreHistory()
        case .newer: await listening.loadMoreHistory(newer: true)
        }
    }
    private func transcriptRow(_ segment: ListeningSegment) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text(segment.recordedAt.formatted(date: .omitted, time: .shortened))
                    .font(.system(size: 13, weight: .semibold)).monospacedDigit()
                Text(segment.durationLabel).font(.caption).foregroundStyle(InstantStyle.muted)
                Spacer()
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(InstantStyle.muted)
            }
            Label(segment.location?.displayLabel ?? "Location unavailable", systemImage: "mappin.and.ellipse")
                .font(.caption).foregroundStyle(InstantStyle.muted).lineLimit(2)
                .accessibilityIdentifier("echo.row.location")
            Text(segment.displayTranscript).font(.system(size: 16)).lineSpacing(4).lineLimit(3)
                .foregroundStyle(segment.status == "transcribed" ? InstantStyle.ink : InstantStyle.muted)
        }.padding(.vertical, 4).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
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
    private var current: ListeningSegment { listening.history.first { $0.id == segment.id } ?? editedSegment ?? segment }
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
                    if let count = current.segmentCount { Text("\(count) speech segments in this batch").font(.caption).foregroundStyle(InstantStyle.muted) }
                    Text(current.displayTranscript).font(.system(size: 18)).lineSpacing(7).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("listening.full-transcript")
                    if let error = listening.loadError { Text(error).font(.footnote).foregroundStyle(InstantStyle.accent) }
                }.padding(24)
            }.background(InstantStyle.paper).foregroundStyle(InstantStyle.ink)
                .navigationTitle("Echo").navigationBarTitleDisplayMode(.inline)
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
