import SwiftUI
import InstantClient

/// A real hold across the composer. Taps continue to the text view/buttons;
/// recognition cancels their touch and tracks the finger until release.
struct ComposerHoldGesture: UIGestureRecognizerRepresentable {
    var enabled: Bool
    var onBegan: () -> Void
    var onMoved: (Bool) -> Void
    var onEnded: () -> Void
    var onCancelled: () -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UILongPressGestureRecognizer {
        let recognizer = UILongPressGestureRecognizer()
        recognizer.minimumPressDuration = 0.35
        recognizer.allowableMovement = 12
        recognizer.cancelsTouchesInView = true
        recognizer.isEnabled = enabled
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UILongPressGestureRecognizer, context: Context) {
        recognizer.isEnabled = enabled
    }

    func handleUIGestureRecognizerAction(_ recognizer: UILongPressGestureRecognizer, context: Context) {
        // Window coordinates remain stable when dismissing the keyboard moves the dock.
        let y = recognizer.location(in: nil).y
        switch recognizer.state {
        case .began:
            context.coordinator.originY = y
            onBegan()
        case .changed:
            onMoved(y - context.coordinator.originY < -65)
        case .ended:
            onMoved(y - context.coordinator.originY < -65)
            onEnded()
        case .cancelled, .failed:
            onCancelled()
        default:
            break
        }
    }

    final class Coordinator {
        var originY: CGFloat = 0
    }
}

/// Hold-to-talk state for one composer: recording, slide-to-cancel, the overlay and notices.
/// Each screen owns one and decides what a finished clip becomes.
@MainActor @Observable
final class VoiceInput {
    var active = ProcessInfo.processInfo.arguments.contains("--voice-preview")
    var cancelled = false
    var notice: String?
    /// A released clip is being delivered, e.g. turned into text for a task.
    private(set) var transcribing = false
    @ObservationIgnored private var blocked = false
    @ObservationIgnored private var completion: Task<Void, Never>?

    static let didNotCatch = "Didn't catch that. Hold the input field while you speak, then release."

    func begin(_ dictation: VoiceDictation, echoActive: Bool, assistantName: String) {
        notice = nil
        guard dictation.phase == .idle, completion == nil else { blocked = true; return }
        if echoActive {
            blocked = true
            notice = "Echo is using the microphone. Stop Echo to talk to \(assistantName)."
            return
        }
        active = true
        cancelled = false
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        dictation.begin()
    }

    func move(cancel: Bool) {
        guard active, cancel != cancelled else { return }
        cancelled = cancel
        UISelectionFeedbackGenerator().selectionChanged()
    }

    func end(_ dictation: VoiceDictation, deliver: @escaping @MainActor (VoiceClip) async throws -> Void) {
        if blocked { blocked = false; return }
        guard active else { return }
        let wasCancelled = cancelled
        active = false
        cancelled = false
        if wasCancelled { dictation.cancel(); return }
        completion = Task {
            defer { completion = nil; transcribing = false }
            switch await dictation.finish() {
            case .clip(let clip):
                guard !Task.isCancelled else { return }
                transcribing = true
                do { try await deliver(clip) }
                catch { if !Task.isCancelled, let message = Self.message(for: error) { notice = message } }
            case .empty: if !Task.isCancelled { notice = Self.didNotCatch }
            case .unavailable(let message): if !Task.isCancelled { notice = message }
            }
        }
    }

    /// Stops this composer's recording or delivery; another composer's recording is left alone.
    func cancel(_ dictation: VoiceDictation) {
        let owned = active || completion != nil
        completion?.cancel()
        completion = nil
        active = false
        cancelled = false
        blocked = false
        transcribing = false
        if owned { dictation.cancel() }
    }

    static func message(for error: any Error) -> String? {
        if error is CancellationError { return nil }
        if (error as? InstantAPIError)?.code == "empty_transcript" { return didNotCatch }
        if let error = error as? VoiceTranscriptionError { return error.errorDescription }
        return "Couldn't transcribe that. Check your connection and try again."
    }
}

/// The one message composer used by Chat, new tasks and task conversations: attach, native
/// multiline text, and a voice button that becomes Send once there is text. Holding anywhere on
/// an empty composer records; sliding up cancels.
struct ChatComposer: View {
    @Environment(AppModel.self) private var model
    @Environment(ListeningModel.self) private var listening
    @Environment(\.scenePhase) private var phase
    @Binding var text: String
    @Binding var focused: Bool
    let placeholder: String
    /// Accessibility prefix: `<identifier>.input`, `.voice`, `.send`, `.voice.notice`.
    var identifier = "chat"
    var sendDisabled = false
    /// Shows "Transcribing…" while a clip becomes composer text or a new task.
    var showsTranscribing = true
    let voice: VoiceInput
    let onSend: () -> Void
    let onClip: @MainActor (VoiceClip) async throws -> Void
    @State private var showAttachment = false

    var body: some View {
        VStack(spacing: 10) {
            if let notice = voice.notice ?? (showsTranscribing && voice.transcribing ? "Transcribing…" : nil) {
                HStack(alignment: .top, spacing: 8) {
                    Text(notice).font(.caption).frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("\(identifier).voice.notice")
                    if voice.notice != nil {
                        Button { voice.notice = nil } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }
                            .accessibilityLabel("Dismiss voice notice")
                    }
                }.foregroundStyle(InstantStyle.muted).padding(.leading, 14).padding(.trailing, 4).frame(minHeight: 44)
                    .background(InstantStyle.paperElevated, in: RoundedRectangle(cornerRadius: 16))
            }
            row
        }
        .onChange(of: phase) { _, phase in
            if phase == .background || (phase == .inactive && model.dictation.phase != .starting) { voice.cancel(model.dictation) }
        }
        .onDisappear { voice.cancel(model.dictation) }
        .sheet(isPresented: $showAttachment) {
            VStack(spacing: 22) {
                Image(systemName: "paperclip").font(.largeTitle).foregroundStyle(InstantStyle.accent)
                Text("Bring something to the conversation").font(InstantStyle.serif(25)).multilineTextAlignment(.center)
                Text("File and camera uploads are coming next. For this demo, you can paste text into your message.").foregroundStyle(.secondary).multilineTextAlignment(.center)
                PillButton(title: "Got it") { showAttachment = false }
            }.padding(28).presentationDetents([.medium]).presentationBackground(InstantStyle.paper).swipeToDismiss()
        }
    }

    private var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private var row: some View {
        HStack(spacing: 9) {
            Button { showAttachment = true } label: {
                Image(systemName: "plus").font(.system(size: 26, weight: .light)).frame(width: 32, height: 42)
            }.accessibilityLabel("Add attachment")
            ComposerTextView(text: $text, focused: $focused, identifier: "\(identifier).input", onSend: { if !sendDisabled { onSend() } })
                .overlay(alignment: .leading) {
                    if text.isEmpty {
                        Text(placeholder).font(.system(size: 15)).foregroundStyle(InstantStyle.muted).lineLimit(1)
                            .allowsHitTesting(false)
                    }
                }
            if isEmpty {
                Image(systemName: "waveform").font(.system(size: 21, weight: .regular))
                    .frame(width: 44, height: 44)
                    .background(InstantStyle.orangePaper, in: Circle())
                    .overlay(Circle().strokeBorder(InstantStyle.paperElevated.opacity(0.8), lineWidth: 1))
                    .foregroundStyle(InstantStyle.forest).contentShape(Rectangle())
                    .accessibilityElement().accessibilityLabel("Hold to talk")
                    .accessibilityHint("Release to send. Slide up to cancel.")
                    .accessibilityIdentifier("\(identifier).voice")
                    .accessibilityAddTraits(.isButton)
            } else {
                Button(action: onSend) {
                    Image(systemName: "arrow.up").font(.system(size: 21, weight: .semibold))
                        .frame(width: 44, height: 44)
                        .background(InstantStyle.orangePaper, in: Circle())
                        .foregroundStyle(InstantStyle.forest)
                }.frame(width: 44, height: 44).disabled(sendDisabled)
                    .accessibilityLabel("Send message").accessibilityIdentifier("\(identifier).send")
            }
        }
        .padding(.leading, 12).padding(.trailing, 6).padding(.vertical, 5)
        .foregroundStyle(InstantStyle.forest)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 29))
        .contentShape(RoundedRectangle(cornerRadius: 29))
        .gesture(ComposerHoldGesture(enabled: text.isEmpty,
            onBegan: {
                focused = false
                voice.begin(model.dictation, echoActive: listening.isListening, assistantName: model.assistantName)
            },
            onMoved: { voice.move(cancel: $0) },
            onEnded: { voice.end(model.dictation, deliver: onClip) },
            onCancelled: { voice.cancel(model.dictation) }))
        .overlay(RoundedRectangle(cornerRadius: 29).strokeBorder(InstantStyle.paperElevated, lineWidth: 1))
        .shadow(color: InstantStyle.forest.opacity(0.06), radius: 7, y: 3)
    }
}

/// Full-width recording feedback above the composer while a hold is active.
struct VoiceOverlay: View {
    @Environment(AppModel.self) private var model
    let voice: VoiceInput

    var body: some View {
        if voice.active { overlay.transition(.opacity) }
    }

    private var overlay: some View {
        let preview = ProcessInfo.processInfo.arguments.contains("--voice-preview")
        let levels = preview ? (0..<40).map { 0.25 + 0.6 * abs(sin(Double($0) * 0.55)) } : model.dictation.levels
        let cancelled = voice.cancelled
        let tint = cancelled ? Color.red : InstantStyle.accent
        return ZStack(alignment: .bottom) {
            // An opaque paper base hides the composer and tabs; the tinted glow sits on top.
            ZStack {
                LinearGradient(stops: [.init(color: InstantStyle.paper.opacity(0), location: 0), .init(color: InstantStyle.paper, location: 0.3), .init(color: InstantStyle.paper, location: 1)], startPoint: .top, endPoint: .bottom)
                LinearGradient(stops: [.init(color: tint.opacity(0), location: 0.15), .init(color: tint.opacity(0.28), location: 0.55), .init(color: tint.opacity(0.62), location: 1)], startPoint: .top, endPoint: .bottom)
            }
            .frame(height: 360).frame(maxWidth: .infinity)
            .ignoresSafeArea(edges: .bottom)
            .animation(.easeOut(duration: 0.15), value: cancelled)
            VStack(spacing: 18) {
                Text(cancelled ? "Release to cancel" : "Release to send · Slide up to cancel")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(cancelled ? Color.red : InstantStyle.forest)
                HStack(alignment: .center, spacing: 3) {
                    ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                        Capsule().fill(cancelled ? Color.red.opacity(0.75) : InstantStyle.paperElevated)
                            .frame(width: 3, height: 4 + 30 * level)
                    }
                }
                .frame(height: 36)
                .animation(.easeOut(duration: 0.08), value: levels)
            }
            .padding(.bottom, 82)
        }
        .frame(maxHeight: .infinity, alignment: .bottom)
        .ignoresSafeArea(.container, edges: .bottom)
        .ignoresSafeArea(.keyboard)
        .allowsHitTesting(false)
        .accessibilityIdentifier("voice.preview")
    }
}
