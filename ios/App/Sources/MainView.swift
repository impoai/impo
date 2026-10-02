import SwiftUI
import InstantClient

struct MainView: View {
    @Environment(AppModel.self) private var model
    @Environment(TasksModel.self) private var tasks
    @Environment(ListeningModel.self) private var listening
    @Environment(ClientPermissions.self) private var permissions
    @Environment(\.scenePhase) private var phase
    @State private var showSettings = false
    @State private var showSearch = false
    @State private var composer = ""
    @State private var search = ""
    @State private var voice = VoiceInput()
    @State private var composerFocused = false
    @State private var chooseBriefDraft = false

    var body: some View {
        @Bindable var model = model
        @Bindable var listening = listening
        @Bindable var permissions = permissions
        ZStack {
            InstantBackground()
            if showSettings {
                SettingsView { withAnimation(.easeOut(duration: 0.2)) { showSettings = false } }
                    .swipeBack { withAnimation(.easeOut(duration: 0.2)) { showSettings = false } }
            } else {
                VStack(spacing: 0) {
                    if model.selectedTab == 0 { chatHeader }
                    Group {
                        switch model.selectedTab {
                        case 1: TodayView()
                        case 2: TasksView()
                        case 3: MemoriesView()
                        case 4: AssistantView()
                        default: ChatView(search: search)
                        }
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .safeAreaInset(edge: .bottom, spacing: 0) { bottomDock }
            }
            VoiceOverlay(voice: voice)
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if listening.isListening {
                ListeningStatusView { composerFocused = false; model.selectedTab = 3; model.transcriptNavigationID = UUID() }
                    .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 10)
            }
        }
        .animation(.easeOut(duration: 0.18), value: voice.active)
        .sheet(isPresented: $listening.showIntroduction) { ListeningIntroduction().swipeToDismiss() }
        .task { permissions.enteredToday(model.selectedTab == 1); await model.restoreConversation() }
        .onChange(of: model.selectedTab) { _, tab in permissions.enteredToday(tab == 1) }
        .onChange(of: model.listeningScope) { _, _ in composer = ""; chooseBriefDraft = false; model.pendingBriefDraft = nil }
        .onChange(of: model.pendingBriefDraft) { _, draft in
            guard let draft else { return }
            if composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                composer = draft; model.pendingBriefDraft = nil; composerFocused = true
            } else { chooseBriefDraft = true }
        }
        .alert("Use this Brief suggestion?", isPresented: $chooseBriefDraft) {
            Button("Replace draft") { composer = model.pendingBriefDraft ?? composer; model.pendingBriefDraft = nil; composerFocused = true }
            Button("Keep current draft", role: .cancel) { model.pendingBriefDraft = nil }
        } message: { Text("You already have a message in progress. Nothing will be sent automatically.") }
        .sheet(item: $permissions.presentation, onDismiss: { permissions.offerNotificationsIfNeeded() }) { sheet in
            Group {
                switch sheet {
                case .notifications: NotificationPermissionView()
                case .city: ManualCityView()
                }
            }.swipeToDismiss()
        }
        .onChange(of: phase) { _, phase in
            if phase == .active { Task { await model.restoreConversation() } }
            else if phase == .background { model.suspendStream() }
        }
        .onChange(of: model.useLiveBackend) { _, _ in model.changeChatMode() }
        .onChange(of: showSettings) { old, new in
            if old && !new { model.persistProfile(); Task { await model.restoreConversation() } }
        }
    }

    private var chatHeader: some View {
        VStack(spacing: 9) {
            HStack(spacing: 7) {
                Button { model.selectedTab = 4 } label: {
                    HStack(spacing: 8) {
                        AssistantAvatar(index: model.avatarIndex, size: 40)
                        Text(model.assistantName).font(InstantStyle.serif(24, italic: true)).lineLimit(1).minimumScaleFactor(0.75)
                    }.frame(minHeight: 44).padding(.trailing, 3).contentShape(Rectangle())
                }.buttonStyle(PressStyle()).accessibilityLabel("Your assistant, \(model.assistantName)").accessibilityIdentifier("chat.assistant")
                Spacer()
                CircleButton(symbol: "magnifyingglass", label: "Search conversation") { withAnimation { showSearch.toggle(); if !showSearch { search = "" } } }
                    .accessibilityIdentifier("chat.search")
                CircleButton(symbol: "gearshape", label: "Settings") { composerFocused = false; showSettings = true }
                    .accessibilityIdentifier("chat.settings")
                NotificationPermissionButton()
            }
            if showSearch {
                TextField("Search this conversation", text: $search).padding(12)
                    .paperSurface(cornerRadius: 22)
                    .accessibilityIdentifier("chat.search.field")
            }
        }.padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 8)
    }

    private var bottomDock: some View {
        VStack(spacing: 10) {
            if let notice = listening.notice {
                HStack(alignment: .top, spacing: 8) {
                    Text(notice).font(.caption).frame(maxWidth: .infinity, alignment: .leading)
                    Button { listening.notice = nil } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }
                        .accessibilityLabel("Dismiss listening notice")
                }.foregroundStyle(InstantStyle.muted).padding(.leading, 14).padding(.trailing, 4)
                    .background(InstantStyle.paperElevated, in: RoundedRectangle(cornerRadius: 16))
            }
            ChatComposer(text: $composer, focused: $composerFocused,
                         placeholder: model.selectedTab == 3 ? "Tell \(model.assistantName) more about you..."
                             : model.selectedTab == 2 ? "Ask \(model.assistantName) to research, plan, or create" : "Chat or hold to speak...",
                         sendDisabled: model.isThinking && model.selectedTab != 2, voice: voice, onSend: send, onClip: deliverVoice)

            if !composerFocused {
                HStack(spacing: 1) {
                    tab(0, title: "Chat", symbol: "bubble")
                    tab(1, title: "Brief", symbol: "calendar")
                    Button { composerFocused = false; listening.toggle() } label: {
                        VStack(spacing: 2) {
                            Image(systemName: listening.isListening ? "stop.fill" : "waveform")
                                .font(.system(size: 21, weight: .medium)).frame(width: 42, height: 32)
                            Text(listening.isStarting ? "Cancel" : listening.isListening ? "Stop" : "Echo").font(.system(size: 10, weight: .medium))
                        }.foregroundStyle(InstantStyle.paperElevated)
                            .frame(maxWidth: .infinity).frame(height: 50)
                            .background(listening.isListening ? InstantStyle.accent : InstantStyle.forest, in: Capsule())
                    }.buttonStyle(PressStyle())
                        .accessibilityLabel(listening.isStarting ? "Cancel microphone setup" : listening.isListening ? "Stop Echo recording" : "Start Echo recording")
                        .accessibilityIdentifier("listening.toggle")
                    tab(2, title: "Tasks", symbol: "checklist")
                    tab(3, title: "Memories", symbol: "sparkles")
                }
                .padding(6)
                .instantGlass(cornerRadius: 33, tint: InstantStyle.sage.opacity(0.28))
            }
        }
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 4)
    }

    private func tab(_ index: Int, title: String, symbol: String) -> some View {
        let ids = ["chat", "today", "tasks", "memories", "assistant"]
        return Button {
            composerFocused = false
            withAnimation(.easeOut(duration: 0.16)) { model.selectedTab = index }
        } label: {
            VStack(spacing: 2) {
                if index == 0 { Image(systemName: model.selectedTab == 0 ? "text.bubble.fill" : "text.bubble").font(.system(size: 22)).frame(height: 25) }
                else if index == 3 { Image(systemName: "books.vertical").font(.system(size: 22)).frame(height: 25) }
                else if index == 4 { AssistantAvatar(index: model.avatarIndex, size: 25) }
                else { Image(systemName: symbol).font(.system(size: 23, weight: .regular)).frame(height: 25) }
                Text(title).font(.system(size: 10, weight: .medium)).lineLimit(1)
            }
            .foregroundStyle(model.selectedTab == index ? InstantStyle.ink : InstantStyle.muted)
            .frame(maxWidth: .infinity).frame(height: 50)
            .background(model.selectedTab == index ? InstantStyle.orangePaper.opacity(0.55) : .clear, in: Capsule())
            .overlay(Capsule().strokeBorder(model.selectedTab == index ? InstantStyle.paperElevated : .clear, lineWidth: 0.7))
            .contentShape(Capsule())
        }.buttonStyle(PressStyle()).accessibilityIdentifier("tab.\(ids[index])")
            .accessibilityAddTraits(model.selectedTab == index ? .isSelected : [])
    }

    /// Chat sends the clip itself: the server transcribes it and replies in one step, while a
    /// "…" bubble holds its place. A task starts from text, and a busy chat keeps the words as a draft.
    private func deliverVoice(_ clip: VoiceClip) async throws {
        if model.selectedTab != 2 { model.selectedTab = 0 }
        if model.selectedTab != 2, model.sendVoice(clip) { return }
        let text = try await model.transcribe(clip)
        composer = composer.isEmpty ? text : composer + " " + text
        if model.selectedTab == 2 { send() }
    }

    private func send() {
        guard !composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        if model.selectedTab == 2 {
            // On the Tasks tab the composer starts a new task, as in the reference design.
            let text = composer
            composer = ""; composerFocused = false
            Task {
                do { tasks.route = .detail(try await tasks.create(text, using: model)) }
                catch is CancellationError {} // The account changed; its text must not reappear.
                catch { composer = text; tasks.loadError = (error as? TaskInputError)?.errorDescription ?? "Couldn't create this task. Check your connection and try again." }
            }
            return
        }
        guard !model.isThinking else { return }
        model.selectedTab = 0
        if model.send(composer) { composer = ""; composerFocused = false }
    }
}

private struct ChatTabSymbol: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            let w = rect.width, h = rect.height
            path.move(to: CGPoint(x: w * 0.24, y: h * 0.83))
            path.addLine(to: CGPoint(x: w * 0.06, y: h * 0.98))
            path.addLine(to: CGPoint(x: w * 0.12, y: h * 0.71))
            path.addCurve(to: CGPoint(x: w * 0.50, y: h * 0.03), control1: CGPoint(x: -w * 0.15, y: h * 0.32), control2: CGPoint(x: w * 0.10, y: h * 0.03))
            path.addCurve(to: CGPoint(x: w * 0.98, y: h * 0.43), control1: CGPoint(x: w * 0.83, y: h * 0.01), control2: CGPoint(x: w * 0.98, y: h * 0.20))
            path.addCurve(to: CGPoint(x: w * 0.24, y: h * 0.83), control1: CGPoint(x: w * 0.98, y: h * 0.82), control2: CGPoint(x: w * 0.57, y: h * 0.94))
        }
    }
}

private struct ChatView: View {
    @Environment(AppModel.self) private var model
    var search: String
    @State private var scenarioPage = 0
    private let scenarios: [(String, String, String)] = [
        ("Work & Projects", "Move your ideas and everyday projects forward", "folder"),
        ("Schedule & To-dos", "Make room for what matters in your day", "calendar.badge.clock"),
        ("Health & Fitness", "Build a routine for movement and recovery", "dumbbell"),
        ("Investing & Personal Finance", "Research options and organize your goals", "chart.xyaxis.line"),
        ("Travel Planning", "Compare options, plan your itinerary, and get ready", "airplane.ticket")
    ]
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 9) {
                    if search.isEmpty {
                        greetingCard
                        if let selected = model.selectedScenario {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("What should we start with?").font(InstantStyle.serif(18))
                                Label("Answered: \(selected)", systemImage: "checkmark").font(.system(size: 16)).foregroundStyle(InstantStyle.muted)
                            }.padding(15).frame(maxWidth: .infinity, alignment: .leading).paperSurface(cornerRadius: 14)
                        } else { scenarioCard }
                    }
                    ForEach(model.messages.filter { search.isEmpty || $0.text.localizedCaseInsensitiveContains(search) }) { message in
                        // A voice message shows "…" until the server returns its transcript.
                        if message.role == "user" && message.text.isEmpty { TranscribingBubble().id(message.id) }
                        else {
                            VStack(alignment: .leading, spacing: 8) {
                                if !message.text.isEmpty { bubble(message.text, user: message.role == "user") }
                                if !message.files.isEmpty { DeliveredFilesView(files: message.files) }
                            }.id(message.id)
                        }
                    }
                    if !search.isEmpty && !model.messages.contains(where: { $0.text.localizedCaseInsensitiveContains(search) }) {
                        Text("No messages found").foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.top, 50)
                    }
                    if model.isThinking && !model.awaitingTranscript {
                        LiveStepList(steps: model.liveSteps)
                        HStack(spacing: 8) { ProgressView().controlSize(.mini); Text(model.deviceToolStatus ?? "Thinking...").font(.system(size: 14)) }
                            .foregroundStyle(InstantStyle.muted).padding(8).accessibilityIdentifier("chat.thinking")
                    }
                    if let error = model.chatError {
                        VStack(alignment: .leading, spacing: 9) {
                            Text(error).font(.system(size: 14))
                            Button("Retry") { model.retry() }.font(.system(size: 14, weight: .semibold)).accessibilityIdentifier("chat.retry")
                        }.padding(15).paperSurface(cornerRadius: 14)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }.padding(.horizontal, 19).padding(.top, 2).padding(.bottom, 10)
            }
            .scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively)
            .followsBottom(proxy, content: [AnyHashable(model.messages.count), AnyHashable(model.messages.last?.text.count ?? 0), AnyHashable(model.messages.last?.files.count ?? 0), AnyHashable(model.isThinking), AnyHashable(model.chatError), AnyHashable(model.liveSteps.count), AnyHashable(model.awaitingTranscript)],
                           enabled: search.isEmpty, identifier: "chat.scrollToBottom")
        }
    }

    private var greetingCard: some View {
        HStack(alignment: .bottom, spacing: 10) {
            VStack(alignment: .leading, spacing: 13) {
                Text("\(model.displayName.isEmpty ? "Hey" : "Hey \(model.displayName)") — \(model.assistantName), I like it. It feels both friendly and a little mysterious at the same time.")
                    .font(InstantStyle.serif(14)).lineSpacing(3)
                    .foregroundStyle(InstantStyle.ink.opacity(0.88))
                    .accessibilityIdentifier("chat.message.assistant")
                Text("What's on your mind today?")
                    .font(InstantStyle.serif(27, italic: true)).lineSpacing(1)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("chat.message.assistant")
            }.frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
            Image("JournalRobin").resizable().scaledToFit()
                .frame(width: 112, height: 136).rotationEffect(.degrees(-5))
                .accessibilityHidden(true)
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
        .background {
            UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 5, topTrailingRadius: 18)
                .fill(InstantStyle.orangePaper)
                .shadow(color: InstantStyle.border.opacity(0.25), radius: 0, y: 3)
        }
        .overlay(UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 5, topTrailingRadius: 18).strokeBorder(InstantStyle.accent.opacity(0.8), lineWidth: 0.8))
        .padding(.bottom, 4)
    }

    private func bubble(_ text: String, user: Bool) -> some View {
        HStack {
            if user { Spacer(minLength: 55) }
            Group { if user { Text(text).textSelection(.enabled) } else { AssistantMarkdown(text: text) } }.font(.system(size: 17)).lineSpacing(5)
                .padding(.horizontal, 13).padding(.vertical, 10)
                .background(user ? InstantStyle.peach : InstantStyle.paperElevated, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(InstantStyle.border.opacity(0.8), lineWidth: 0.7))
                .overlay(alignment: user ? .bottomTrailing : .bottomLeading) {
                    BubbleTail().fill(user ? InstantStyle.peach : InstantStyle.paperElevated)
                        .frame(width: 9, height: 7).scaleEffect(x: user ? -1 : 1, y: 1)
                        .padding(.horizontal, 7).offset(y: 4)
                }
                .accessibilityIdentifier(user ? "chat.message.user" : "chat.message.assistant")
            if !user { Spacer(minLength: 23) }
        }.frame(maxWidth: .infinity, alignment: user ? .trailing : .leading)
    }

    private var scenarioCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button { scenarioPage = 0 } label: { Image(systemName: "chevron.left").frame(width: 44, height: 34) }.disabled(scenarioPage == 0)
                Spacer()
                Text("\(scenarioPage + 1) / 2").font(InstantStyle.serif(13, italic: true)).tracking(2).foregroundStyle(InstantStyle.muted)
                Spacer()
                Button { scenarioPage = 1 } label: { Image(systemName: "chevron.right").frame(width: 44, height: 34) }.disabled(scenarioPage == 1)
                    .accessibilityIdentifier("scenario.next")
            }.font(.system(size: 12)).foregroundStyle(InstantStyle.muted)
            Text("What should we start with?").font(InstantStyle.serif(18)).padding(.bottom, 2)
            // Both pages always occupy the taller page's height. The chat is anchored to the
            // bottom, so a shorter page would move the page arrows out from under the finger.
            ZStack(alignment: .top) {
                scenarioPageContent(0) {
                    ForEach(Array(scenarios.enumerated()), id: \.offset) { index, scenario in
                        scenarioRow(title: scenario.0, subtitle: scenario.1, icon: scenario.2, number: index + 1)
                            .accessibilityIdentifier("scenario.\(index)")
                    }
                }
                scenarioPageContent(1) {
                    scenarioRow(title: "Everyday Life", subtitle: "A little more space for the things you love", icon: "sun.max")
                    scenarioRow(title: "Learning & Ideas", subtitle: "Explore a question, a book, or something new", icon: "book")
                    scenarioRow(title: "Something else", subtitle: "I have something else in mind", icon: "bubble.left")
                        .accessibilityIdentifier("scenario.other")
                }
            }
        }.padding(.top, 2)
    }

    private func scenarioPageContent<Rows: View>(_ page: Int, @ViewBuilder rows: () -> Rows) -> some View {
        let visible = scenarioPage == page
        return VStack(alignment: .leading, spacing: 8) { rows() }
            .opacity(visible ? 1 : 0)
            .allowsHitTesting(visible)
            .accessibilityHidden(!visible)
    }

    private func scenarioRow(title: String, subtitle: String, icon: String, number: Int? = nil) -> some View {
        Button { model.chooseScenario(title) } label: {
            HStack(spacing: 12) {
                ScenarioIllustration(symbol: icon).frame(width: 43, height: 43)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(InstantStyle.serif(17))
                    Text(subtitle).font(.system(size: 12.5)).foregroundStyle(InstantStyle.muted).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }.padding(.leading, 12).padding(.trailing, 23).padding(.vertical, 9).frame(minHeight: 68)
                .paperSurface(cornerRadius: 11)
                .overlay(alignment: .topTrailing) {
                    if let number {
                        Text(String(format: "%02d", number)).font(InstantStyle.serif(9, italic: true))
                            .foregroundStyle(InstantStyle.muted).padding(8).accessibilityHidden(true)
                    }
                }
        }.buttonStyle(PressStyle()).disabled(model.isThinking)
    }
}

private struct BubbleTail: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: .zero)
            path.addQuadCurve(to: CGPoint(x: 0, y: rect.height), control: CGPoint(x: rect.width * 0.35, y: rect.height * 0.5))
            path.addQuadCurve(to: CGPoint(x: rect.width, y: 0), control: CGPoint(x: rect.width * 0.75, y: rect.height * 0.7))
            path.closeSubpath()
        }
    }
}

/// UITextView keeps native multiline editing while its Send key submits rather
/// than inserting a newline. Pasted multiline text remains intact.
struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    var identifier = "chat.input"
    var onSend: () -> Void

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 16))
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textColor = UIColor(InstantStyle.ink)
        view.tintColor = UIColor(InstantStyle.forest)
        view.textContainerInset = UIEdgeInsets(top: 11, left: 0, bottom: 11, right: 0)
        view.textContainer.lineFragmentPadding = 0
        view.returnKeyType = .send
        view.enablesReturnKeyAutomatically = true
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.accessibilityIdentifier = identifier
        view.accessibilityLabel = "Message"
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        // Native editing owns the buffer until submission. In particular, don't
        // replace marked text while a Chinese/Japanese IME is composing.
        if view.text != text && view.markedTextRange == nil && (!view.isFirstResponder || text.isEmpty) { view.text = text }
        if !focused && view.isFirstResponder { view.resignFirstResponder() }
        // Focus requested by the screen, e.g. after choosing a suggestion to edit.
        if focused && !view.isFirstResponder && view.window != nil { DispatchQueue.main.async { view.becomeFirstResponder() } }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 240
        let height = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        return CGSize(width: width, height: min(110, max(42, height)))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextView
        init(_ parent: ComposerTextView) { self.parent = parent }
        func textViewDidBeginEditing(_ textView: UITextView) { if !parent.focused { parent.focused = true } }
        func textViewDidEndEditing(_ textView: UITextView) { if parent.focused { parent.focused = false } }
        func textViewDidChange(_ textView: UITextView) { if parent.text != textView.text { parent.text = textView.text } }
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            if text == "\n" { parent.onSend(); return false }
            return true
        }
    }
}

/// Live progress of a running reply: what the assistant is doing right now. Not stored;
/// once the reply finishes only the answer remains.
struct LiveStepList: View {
    let steps: [StreamStep]

    var body: some View {
        if !steps.isEmpty {
            VStack(alignment: .leading, spacing: 7) {
                ForEach(steps.suffix(8)) { step in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: symbol(step.kind)).font(.system(size: 12)).frame(width: 16)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(step.title).font(.system(size: 13, weight: .medium))
                            if let detail = step.detail {
                                Text(detail).font(step.kind == "command" ? .system(size: 12, design: .monospaced) : .system(size: 12))
                                    .lineLimit(2)
                            }
                            if let result = step.result {
                                Text(result).font(.system(size: 11, design: .monospaced)).foregroundStyle(.red.opacity(0.75))
                                    .lineLimit(4).accessibilityLabel("Failed: \(result)")
                            }
                        }
                        Spacer(minLength: 4)
                        status(step.status)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .foregroundStyle(InstantStyle.muted)
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(InstantStyle.paperElevated.opacity(0.7), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(InstantStyle.border.opacity(0.6), lineWidth: 0.6))
            .accessibilityIdentifier("reply.steps")
        }
    }

    private func symbol(_ kind: String) -> String {
        switch kind {
        case "command": "terminal"
        case "search": "magnifyingglass"
        case "tool": "wrench.and.screwdriver"
        case "reasoning": "sparkles"
        default: "text.bubble"
        }
    }

    @ViewBuilder private func status(_ value: String) -> some View {
        switch value {
        case "completed": Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(InstantStyle.forest)
        case "failed": Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(.red.opacity(0.8))
        default: ProgressView().controlSize(.mini)
        }
    }
}

/// The user's voice message while its transcript is being finalized.
struct TranscribingBubble: View {
    @State private var phase = 0
    var body: some View {
        HStack {
            Spacer(minLength: 55)
            HStack(spacing: 5) {
                ForEach(0..<3) { index in
                    Circle().fill(InstantStyle.forest.opacity(phase == index ? 0.85 : 0.3)).frame(width: 7, height: 7)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 15)
            .background(InstantStyle.peach, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(InstantStyle.border.opacity(0.8), lineWidth: 0.7))
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement().accessibilityLabel("Transcribing your message")
        .accessibilityIdentifier("chat.voice.transcribing")
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(320))
                phase = (phase + 1) % 3
            }
        }
    }
}
