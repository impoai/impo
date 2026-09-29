import SwiftUI
import InstantClient

struct ListeningIntroduction: View {
    @Environment(ListeningModel.self) private var listening
    var body: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: 22) {
            Image(systemName: "waveform").font(.system(size: 34)).foregroundStyle(InstantStyle.accent)
            Text("Keep the words that matter.").font(InstantStyle.serif(32))
            Text("Tap Echo to record, and tap again to stop. Recording continues when you lock your iPhone.")
            Text("Speech is detected on your iPhone. Speech recordings are saved locally, then uploaded in batches. Audio is sent to Impo and Google Gemini for transcription. Once transcribed, Impo removes the audio and keeps the text in Echo. You can delete each recording there.")
            EchoLocationSettings()
            Text("Before recording a conversation, let everyone know and get their permission.")
                .font(.footnote).foregroundStyle(InstantStyle.muted)
            Link("Privacy policy", destination: URL(string: "https://impo.ai/privacy/")!)
                .foregroundStyle(InstantStyle.forest)
            PillButton(title: "Agree and start Echo") { listening.agreeAndStart() }
                .accessibilityIdentifier("listening.agree")
            Button("Not now") { listening.showIntroduction = false }
                .frame(maxWidth: .infinity, minHeight: 44).accessibilityIdentifier("listening.decline")
        }.padding(28).foregroundStyle(InstantStyle.ink)
        }
            .presentationDetents([.large]).presentationDragIndicator(.visible)
            .presentationBackground(InstantStyle.paper)
    }
}

struct ListeningStatusView: View {
    @Environment(ListeningModel.self) private var listening
    var openTranscripts: (() -> Void)?
    var body: some View {
        if listening.isListening {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 12) {
                    if let openTranscripts {
                        Button(action: openTranscripts) { recordingLabel }
                            .buttonStyle(.plain).accessibilityIdentifier("listening.open-transcripts")
                            .accessibilityLabel(listening.isRecording ? "Echo" : "Echo paused")
                            .accessibilityValue(listening.isRecording ? (listening.isSpeaking ? "Speech detected" : "Waiting for speech") : (listening.pauseReason ?? "Microphone paused"))
                    } else { recordingLabel }
                    if !listening.isRecording {
                        Button(listening.isStarting ? "Resuming…" : "Resume") { listening.resume() }
                            .font(.system(size: 13, weight: .medium)).frame(minHeight: 44)
                            .disabled(listening.isStarting).accessibilityIdentifier("listening.resume")
                    }
                    Button { listening.stop() } label: {
                        Image(systemName: "stop.fill").font(.system(size: 14)).frame(width: 44, height: 44)
                            .background(InstantStyle.paperElevated, in: Circle()).foregroundStyle(InstantStyle.forest)
                    }.accessibilityLabel("Stop Echo recording").accessibilityIdentifier("listening.stop")
                }.padding(.horizontal, 16).padding(.vertical, 10).foregroundStyle(EchoWaveform.paper)
                    .background(InstantStyle.forest, in: RoundedRectangle(cornerRadius: 22))
                if let reason = listening.pauseReason {
                    Text(reason).font(.caption).foregroundStyle(InstantStyle.muted).padding(.horizontal, 4)
                }
                if let note = listening.activityNotice {
                    Text(note).font(.caption).foregroundStyle(InstantStyle.muted).padding(.horizontal, 4)
                }
            }
        }
    }
    private var recordingLabel: some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 3) {
                Text(listening.isRecording ? "Echo" : "Echo paused")
                    .font(.custom("Georgia", size: 23, relativeTo: .title3)).lineLimit(1).minimumScaleFactor(0.8)
                if listening.isRecording, let start = listening.startedAt {
                    Text(start, style: .timer).font(.system(size: 13, weight: .medium)).monospacedDigit()
                        .foregroundStyle(EchoWaveform.paper.opacity(0.78)).frame(width: 76, alignment: .leading)
                } else {
                    Text("Microphone paused").font(.caption2).foregroundStyle(EchoWaveform.paper.opacity(0.78))
                }
            }.layoutPriority(1)
            EchoMeterView(meter: listening.meter, isRecording: listening.isRecording, isSpeaking: listening.isSpeaking)
                .frame(maxWidth: .infinity).frame(height: 54)
        }.frame(maxWidth: .infinity, minHeight: 54, alignment: .leading).contentShape(Rectangle())
    }
}

private struct EchoMeterView: View {
    let meter: EchoMeterPresentation
    let isRecording: Bool
    let isSpeaking: Bool
    var body: some View {
        EchoWaveform(levels: meter.levels, isRecording: isRecording, isSpeaking: isSpeaking)
    }
}

struct ListeningTimeline: View {
    @Environment(ListeningModel.self) private var listening
    @Environment(AppModel.self) private var app
    @State private var deleting: ListeningSegment?

    var body: some View {
        @Bindable var listening = listening
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Button { moveDay(-1) } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }
                    .accessibilityLabel("Previous day").accessibilityIdentifier("listening.previous-day")
                DatePicker("Recordings on", selection: $listening.selectedDate, in: ...Date(), displayedComponents: .date)
                    .labelsHidden().frame(maxWidth: .infinity).accessibilityIdentifier("listening.date")
                Button { moveDay(1) } label: { Image(systemName: "chevron.right").frame(width: 44, height: 44) }
                    .disabled(Calendar.current.isDateInToday(listening.selectedDate)).accessibilityLabel("Next day")
            }.instantGlass(cornerRadius: 24)
            if let error = listening.uploadError { Text(error).font(.footnote).foregroundStyle(InstantStyle.muted) }
            if let error = listening.loadError { Text(error).font(.footnote).foregroundStyle(InstantStyle.muted) }
            if !visiblePending.isEmpty {
                Label("\(visiblePending.count) recording\(visiblePending.count == 1 ? "" : "s") waiting to upload", systemImage: "arrow.up.circle")
                    .font(.footnote).foregroundStyle(InstantStyle.muted).accessibilityIdentifier("listening.pending")
            }
            if listening.segments.allSatisfy(\.isSilent) {
                VStack(spacing: 14) {
                    Image(systemName: "waveform.path").font(.system(size: 38, weight: .light)).foregroundStyle(InstantStyle.accent)
                    Text("A place for today's words.").font(InstantStyle.serif(24))
                    Text(app.useLiveBackend ? "Tap the center Echo button to begin. Your transcripts will appear here, in time order." : "Sign in or connect your server in Settings to record and transcribe conversations.")
                        .font(.system(size: 15)).foregroundStyle(InstantStyle.muted).multilineTextAlignment(.center)
                    Text("No recordings on this day").font(.caption).foregroundStyle(InstantStyle.muted)
                }.frame(maxWidth: .infinity).padding(.horizontal, 22).padding(.vertical, 36)
                    .paperSurface(cornerRadius: 20).accessibilityIdentifier("listening.empty")
            } else {
                ForEach(listening.segments.filter { !$0.isSilent }) { segment in
                    HStack(alignment: .top, spacing: 13) {
                        VStack(spacing: 7) {
                            Circle().fill(InstantStyle.accent).frame(width: 8, height: 8)
                            Rectangle().fill(InstantStyle.border).frame(width: 1).frame(maxHeight: .infinity)
                        }.frame(width: 12).padding(.top, 10)
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Text(timeRange(segment)).font(.system(size: 13, weight: .medium)).monospacedDigit()
                                Spacer()
                                Menu {
                                    Button("Delete recording", role: .destructive) { deleting = segment }
                                } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
                                    .accessibilityLabel("Recording options").accessibilityIdentifier("listening.options.\(segment.id)")
                            }
                            if let place = segment.location?.displayLabel {
                                Label(place, systemImage: "mappin.and.ellipse").font(.caption).foregroundStyle(InstantStyle.muted)
                            }
                            if segment.status == "transcribed" {
                                Text(segment.transcript.isEmpty ? "No speech was detected." : segment.transcript)
                                    .font(.system(size: 16)).lineSpacing(5).textSelection(.enabled)
                                    .accessibilityIdentifier("listening.transcript")
                            } else {
                                Label(segment.status == "failed" ? "Couldn't transcribe this recording" : segment.status == "pending" ? "Queued for transcription…" : "Transcribing…",
                                      systemImage: segment.status == "failed" ? "exclamationmark.circle" : "clock")
                                    .font(.system(size: 14)).foregroundStyle(InstantStyle.muted)
                            }
                        }.padding(.horizontal, 16).padding(.bottom, 18).paperSurface(cornerRadius: 17)
                    }.fixedSize(horizontal: false, vertical: true)
                }
            }
            Text("Recordings are source material. Summaries and assistant recall are coming later.")
                .font(.caption).foregroundStyle(InstantStyle.muted).padding(.horizontal, 4)
        }.foregroundStyle(InstantStyle.ink)
            .onChange(of: listening.selectedDate) { _, _ in listening.segments = [] }
            .task(id: Calendar.current.startOfDay(for: listening.selectedDate)) { await listening.refresh() }
            .confirmationDialog("Delete this recording and its transcript?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
                Button("Delete recording", role: .destructive) {
                    if let segment = deleting { Task { await listening.delete(segment) } }
                    deleting = nil
                }
            }
    }

    private var visiblePending: [PendingRecording] {
        listening.pending.filter { Calendar.current.isDate($0.startedAt, inSameDayAs: listening.selectedDate) }
    }
    private func moveDay(_ offset: Int) {
        if let date = Calendar.current.date(byAdding: .day, value: offset, to: listening.selectedDate) {
            listening.segments = []; listening.selectedDate = min(date, Date())
        }
    }
    private func timeRange(_ segment: ListeningSegment) -> String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let start = formatter.date(from: segment.startedAt) ?? ISO8601DateFormatter().date(from: segment.startedAt),
              let end = formatter.date(from: segment.endedAt) ?? ISO8601DateFormatter().date(from: segment.endedAt) else { return "Recording" }
        return start.formatted(date: .omitted, time: .shortened) + " – " + end.formatted(date: .omitted, time: .shortened)
    }
}
