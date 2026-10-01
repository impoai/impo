import SwiftUI
import InstantClient

// in Impo's own paper palette. Template wording is provisional; prompts come later.

struct TaskTemplate: Identifiable {
    let id: String
    let title: String
    let detail: String
    let symbol: String
}

enum TaskCategory: String, CaseIterable, Identifiable {
    case general = "General", health = "Health", work = "Work", life = "Life", information = "Information"
    var id: String { rawValue }

    var templates: [TaskTemplate] {
        switch self {
        case .general: [
            TaskTemplate(id: "priority-list", title: "Daily Priority List", detail: "Pull the few things that matter most today from your calendar, tasks, and messages.", symbol: "list.bullet.indent"),
            TaskTemplate(id: "email-digest", title: "Daily Email Digest", detail: "Sort new email into replies, actions, waiting items, and read-only updates.", symbol: "envelope.open"),
            TaskTemplate(id: "awaiting-reply", title: "Daily Emails Awaiting Reply", detail: "Catch read messages that still need a response, confirmation, or attachment.", symbol: "envelope"),
            TaskTemplate(id: "reply-drafts", title: "Daily Email Reply Drafts", detail: "Draft clear, polished replies while leaving uncertain details for review.", symbol: "square.and.pencil"),
            TaskTemplate(id: "calendar-conflicts", title: "Daily Calendar Conflict Check", detail: "Find overlapping events, back-to-back commitments, and travel time that does not work.", symbol: "calendar.badge.exclamationmark"),
            TaskTemplate(id: "leave-house", title: "Daily Leave-the-House Checklist", detail: "Use the weather, schedule, and destinations to catch what you might forget.", symbol: "bag"),
        ]
        case .work: [
            TaskTemplate(id: "priority-briefing", title: "Daily Priority Briefing", detail: "Start each morning with the most important tasks, meetings, and prep for the day.", symbol: "list.bullet.indent"),
            TaskTemplate(id: "work-email-digest", title: "Daily Email Digest", detail: "Sort new emails into replies, action items, waiting items, and read-only updates.", symbol: "envelope"),
            TaskTemplate(id: "awaiting-reply-check", title: "Awaiting Reply Check", detail: "Find email and message threads that still need a reply, confirmation, or missing information.", symbol: "envelope.open"),
            TaskTemplate(id: "meeting-prep", title: "Meeting Prep Brief", detail: "Prepare background, agenda, open questions, and talking points for today’s important meetings.", symbol: "calendar"),
            TaskTemplate(id: "project-update", title: "Weekly Project Update", detail: "Summarize key project progress, risks, blockers, and next steps every week.", symbol: "chart.line.uptrend.xyaxis"),
            TaskTemplate(id: "deadline-prep", title: "Deadline Prep Check", detail: "Look ahead two weeks and organize upcoming deadlines, dependencies, and risks.", symbol: "calendar.badge.clock"),
        ]
        case .health: [
            TaskTemplate(id: "sleep-review", title: "Weekly Sleep Review", detail: "Look back at your sleep this week and spot what helped or got in the way.", symbol: "bed.double"),
            TaskTemplate(id: "activity-check", title: "Daily Activity Check-in", detail: "See how your steps and active energy compare with your usual days.", symbol: "figure.walk"),
            TaskTemplate(id: "meal-plan", title: "Personalized Meal Plan", detail: "Plan simple, balanced meals around your goals, preferences, and schedule.", symbol: "fork.knife"),
        ]
        case .life: [
            TaskTemplate(id: "weekend-ideas", title: "Weekend Ideas", detail: "Suggest a few things to do this weekend based on your plans and the season.", symbol: "sun.max"),
            TaskTemplate(id: "grocery-list", title: "Grocery List", detail: "Turn this week’s meals and plans into a practical shopping list.", symbol: "cart"),
            TaskTemplate(id: "trip-prep", title: "Trip Prep", detail: "Pull together what you need before an upcoming trip, from bookings to packing.", symbol: "suitcase"),
        ]
        case .information: [
            TaskTemplate(id: "topic-research", title: "Topic Research", detail: "Research a question in depth and summarize the key points and sources.", symbol: "magnifyingglass"),
            TaskTemplate(id: "compare-options", title: "Compare Options", detail: "Lay out the options for a decision side by side, with trade-offs.", symbol: "square.split.2x1"),
            TaskTemplate(id: "reading-summary", title: "Reading Summary", detail: "Summarize an article, report, or long email thread into what matters.", symbol: "doc.text"),
        ]
        }
    }
}

enum TaskRoute: Identifiable, Equatable {
    case new(prefill: String)
    case detail(String)
    var id: String {
        switch self { case .new(let text): "new:\(text)"; case .detail(let id): "detail:\(id)" }
    }
}

struct TasksView: View {
    @Environment(AppModel.self) private var model
    @Environment(TasksModel.self) private var tasks
    @State private var showScheduled = false
    @State private var scheduleRoute: ScheduledTaskRoute?
    @State private var category = TaskCategory.general

    var body: some View {
        @Bindable var tasks = tasks
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Text("Tasks").font(InstantStyle.serif(36))
                    Spacer()
                    Menu {
                        Button { tasks.route = .new(prefill: "") } label: { Label("Add a Task", systemImage: "square.and.pencil") }
                            .accessibilityIdentifier("task.menu.add")
                        Button { showScheduled = true; scheduleRoute = ScheduledTaskRoute() } label: { Label("Add a Scheduled Task", systemImage: "clock") }
                            .accessibilityIdentifier("task.menu.scheduled")
                    } label: {
                        Image(systemName: "plus").font(.system(size: 20, weight: .regular))
                            .frame(width: 48, height: 48).instantGlass(cornerRadius: 24)
                    }.accessibilityLabel("Add a task").accessibilityIdentifier("task.add")
                    NotificationPermissionButton()
                }
                segments
                if showScheduled { ScheduledTasksList { scheduleRoute = ScheduledTaskRoute(value: $0) } }
                else if tasks.tasks.isEmpty { getStarted }
                else { taskList }
                if let error = tasks.loadError, !showScheduled {
                    Text(error).font(.footnote).foregroundStyle(InstantStyle.muted)
                }
            }.padding(.horizontal, 18).padding(.top, 6).padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
        .refreshable { await tasks.refresh(using: model); await tasks.refreshSchedules(using: model) }
        .task(id: model.listeningScope) { await tasks.refresh(using: model); await tasks.refreshSchedules(using: model) }
        .onChange(of: model.listeningScope) { _, _ in scheduleRoute = nil }
        .onChange(of: showScheduled) { _, value in if value { Task { await tasks.refreshSchedules(using: model) } } }
        .sheet(item: $scheduleRoute, onDismiss: { Task { await tasks.refreshSchedules(using: model) } }) { route in
            ScheduledTaskEditor(initial: route.value).id(model.listeningScope)
        }
        .fullScreenCover(item: $tasks.route, onDismiss: { Task { await tasks.refresh(using: model) } }) { route in
            Group {
                switch route {
                case .new(let prefill):
                    NewTaskView(prefill: prefill)
                case .detail(let id):
                    TaskDetailView(thread: tasks.thread(for: id, app: model))
                }
            }.swipeToDismiss()
        }
    }

    private var segments: some View {
        HStack(spacing: 12) {
            segment("Tasks", symbol: "list.bullet", selected: !showScheduled, id: "task.segment.tasks") { showScheduled = false }
            segment("Scheduled", symbol: "clock", selected: showScheduled, id: "task.segment.scheduled") { showScheduled = true }
        }
    }

    private func segment(_ title: String, symbol: String, selected: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button { withAnimation(.easeOut(duration: 0.16)) { action() } } label: {
            Label(title, systemImage: symbol).font(.system(size: 17, weight: .medium))
                .frame(maxWidth: .infinity).frame(height: 46)
                .background(selected ? InstantStyle.paperElevated : InstantStyle.border.opacity(0.35), in: Capsule())
                .overlay(Capsule().strokeBorder(selected ? InstantStyle.border.opacity(0.8) : .clear, lineWidth: 0.7))
                .foregroundStyle(selected ? InstantStyle.ink : InstantStyle.muted)
        }.buttonStyle(PressStyle()).accessibilityIdentifier(id)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var getStarted: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Get started").font(.system(size: 19, weight: .medium)).padding(.leading, 4)
            ScrollView(.horizontal) {
                HStack(spacing: 10) {
                    ForEach(TaskCategory.allCases) { item in
                        Button { withAnimation(.easeOut(duration: 0.16)) { category = item } } label: {
                            Text(item.rawValue).font(.system(size: 16, weight: .medium))
                                .padding(.horizontal, 18).frame(height: 38)
                                .background(category == item ? InstantStyle.paperElevated : InstantStyle.border.opacity(0.35), in: Capsule())
                                .overlay(Capsule().strokeBorder(category == item ? InstantStyle.border.opacity(0.8) : .clear, lineWidth: 0.7))
                                .foregroundStyle(category == item ? InstantStyle.ink : InstantStyle.muted)
                        }.buttonStyle(PressStyle()).accessibilityIdentifier("task.category.\(item.rawValue.lowercased())")
                    }
                }
            }.scrollIndicators(.hidden)
            ForEach(category.templates) { template in templateCard(template) }
        }
    }

    private func templateCard(_ template: TaskTemplate) -> some View {
        Button { tasks.route = .new(prefill: template.detail) } label: {
            HStack(alignment: .center, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 12) {
                        Image(systemName: template.symbol).font(.system(size: 19)).frame(width: 26).foregroundStyle(InstantStyle.forest)
                        Text(template.title).font(.system(size: 19)).foregroundStyle(InstantStyle.ink).multilineTextAlignment(.leading)
                    }
                    Text(template.detail).font(.system(size: 15)).foregroundStyle(InstantStyle.muted)
                        .multilineTextAlignment(.leading).lineLimit(2).padding(.leading, 38)
                }
                Spacer(minLength: 0)
                Image(systemName: "plus").font(.system(size: 18)).foregroundStyle(InstantStyle.ink)
                    .frame(width: 40, height: 40).background(InstantStyle.paperElevated, in: Circle())
                    .overlay(Circle().strokeBorder(InstantStyle.border.opacity(0.6), lineWidth: 0.6))
            }
            .padding(.vertical, 18).padding(.horizontal, 18)
            .paperSurface(cornerRadius: 24)
        }.buttonStyle(PressStyle()).accessibilityIdentifier("task.template.\(template.id)")
    }

    private var taskList: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(groups, id: \.title) { group in
                Text(group.title).font(.system(size: 19, weight: .medium)).padding(.leading, 4).padding(.top, 4)
                ForEach(group.items) { item in
                    Button { tasks.route = .detail(item.id) } label: { TaskRow(item: item) }
                        .buttonStyle(PressStyle()).accessibilityIdentifier("task.row")
                }
            }
        }
    }

    private var groups: [(title: String, items: [TaskItem])] {
        let calendar = Calendar.current
        var result: [(title: String, items: [TaskItem])] = []
        for item in tasks.tasks.sorted(by: { $0.lastModifiedAt > $1.lastModifiedAt }) {
            let title = calendar.isDateInToday(item.lastModifiedAt) ? "Today"
                : calendar.isDateInYesterday(item.lastModifiedAt) ? "Yesterday"
                : item.lastModifiedAt.formatted(.dateTime.month(.abbreviated).day())
            if result.last?.title == title { result[result.count - 1].items.append(item) }
            else { result.append((title, [item])) }
        }
        return result
    }


}

private struct TaskRow: View {
    let item: TaskItem
    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            HStack(spacing: 12) {
                Text(item.title).font(.system(size: 17)).lineLimit(1).foregroundStyle(InstantStyle.ink)
                    .modifier(Shimmer(active: item.isRunning))
                Spacer(minLength: 8)
                if item.status == "failed" {
                    Image(systemName: "exclamationmark.circle").foregroundStyle(InstantStyle.accent).accessibilityLabel("Failed")
                }
                Text(item.lastModifiedLabel(now: context.date))
                    .font(.system(size: 15)).foregroundStyle(InstantStyle.muted)
                    .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                    .accessibilityLabel("Last updated \(item.lastModifiedLabel(now: context.date))")
                    .accessibilityIdentifier("task.updatedAt")
            }
            .padding(.horizontal, 24).frame(height: 70)
            .paperSurface(cornerRadius: 28)
        }
    }
}

/// A soft highlight sweeping across text while a task is running (as in the reference list).
private struct Shimmer: ViewModifier {
    var active: Bool
    @State private var phase: CGFloat = -1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        if active && !reduceMotion {
            content
                .overlay {
                    GeometryReader { proxy in
                        LinearGradient(colors: [.clear, InstantStyle.paperElevated.opacity(0.85), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: proxy.size.width * 0.45)
                            .offset(x: phase * proxy.size.width)
                    }.mask(content).allowsHitTesting(false)
                }
                .onAppear { withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) { phase = 1.2 } }
        } else {
            content
        }
    }
}

// MARK: - New task

private struct NewTaskView: View {
    @Environment(AppModel.self) private var model
    @Environment(TasksModel.self) private var tasks
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var sending = false
    @State private var error: String?
    @State private var focused = false
    @State private var voice = VoiceInput()

    private let suggestions: [(String, String)] = [
        ("sparkles", "Get a daily email roundup"),
        ("sparkles", "Get a daily meeting brief"),
        ("party.popper", "Get weekend ideas every Friday"),
    ]

    init(prefill: String) { _text = State(initialValue: prefill) }

    var body: some View {
        ZStack {
            InstantBackground()
            VStack(alignment: .leading, spacing: 0) {
                TaskTopBar(title: "New task", subtitle: nil) { dismiss() }
                Spacer()
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(suggestions, id: \.1) { symbol, suggestion in
                        Button { text = suggestion; focused = true } label: {
                            Label(suggestion, systemImage: symbol).font(.system(size: 17))
                                .padding(.horizontal, 18).frame(height: 50)
                                .background(InstantStyle.paperElevated.opacity(0.9), in: Capsule())
                                .overlay(Capsule().strokeBorder(InstantStyle.border.opacity(0.7), lineWidth: 0.7))
                                .foregroundStyle(InstantStyle.ink)
                        }.buttonStyle(PressStyle())
                    }
                    if let error { Text(error).font(.footnote).foregroundStyle(InstantStyle.accent) }
                    ChatComposer(text: $text, focused: $focused, placeholder: "Describe what you’d like done…", identifier: "task.new",
                                 sendDisabled: sending, voice: voice, onSend: submit) { clip in
                        // A task starts from text: transcribe, then create it like a typed request.
                        text = try await model.transcribe(clip)
                        submit()
                    }
                        .padding(.top, 10)
                }.padding(.horizontal, 16).padding(.bottom, 10)
            }
            VoiceOverlay(voice: voice)
        }
        .animation(.easeOut(duration: 0.18), value: voice.active)
    }

    private func submit() {
        guard !sending else { return }
        sending = true
        error = nil
        Task {
            defer { sending = false }
            do {
                let id = try await tasks.create(text, using: model)
                tasks.route = .detail(id)
            } catch {
                self.error = (error as? TaskInputError)?.errorDescription ?? "Couldn't create this task. Check your connection and try again."
            }
        }
    }
}

// MARK: - Task conversation

struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(TasksModel.self) private var tasks
    @Environment(\.dismiss) private var dismiss
    @State var thread: TaskThreadModel
    @State private var text = ""
    @State private var focused = false
    @State private var voice = VoiceInput()

    var body: some View {
        ZStack {
            InstantBackground()
            VStack(spacing: 0) {
                TaskTopBar(title: thread.title, subtitle: thread) {
                    dismiss()
                    Task { await tasks.refresh(using: model) }
                }
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 14) {
                            if let started = thread.startedAt {
                                Text(timestamp(started)).font(.system(size: 14)).foregroundStyle(InstantStyle.muted)
                                    .frame(maxWidth: .infinity).padding(.vertical, 6)
                            }
                            ForEach(thread.messages) { message in
                                if message.role == "user" { userBubble(message.text) }
                                else {
                                    if !message.text.isEmpty { assistantText(message.text) }
                                    if !message.files.isEmpty { DeliveredFilesView(files: message.files) }
                                }
                            }
                            // Same as Chat: "…" holds the message's place until its text arrives.
                            if voice.transcribing { TranscribingBubble() }
                            if thread.isRunning { LiveStepList(steps: thread.steps) }
                            if thread.isRunning && thread.messages.last?.role != "assistant" {
                                Text("Thinking…").font(.system(size: 16)).foregroundStyle(InstantStyle.muted)
                                    .accessibilityIdentifier("task.thinking")
                            }
                            if let error = thread.error {
                                Text(error).font(.system(size: 14)).padding(14).paperSurface(cornerRadius: 14)
                            }
                            Color.clear.frame(height: 1).id("bottom")
                        }.padding(.horizontal, 18).padding(.bottom, 12)
                    }
                    .scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively)
                    .followsBottom(proxy, content: [AnyHashable(thread.messages.count), AnyHashable(thread.messages.last?.text.count ?? 0), AnyHashable(thread.messages.last?.files.count ?? 0), AnyHashable(thread.isRunning), AnyHashable(thread.error), AnyHashable(thread.steps.count), AnyHashable(voice.transcribing)],
                                   identifier: "task.scrollToBottom")
                }
                ChatComposer(text: $text, focused: $focused, placeholder: "Chat or hold to speak…", identifier: "task.detail",
                             sendDisabled: thread.isRunning, showsTranscribing: false, voice: voice,
                             onSend: { if thread.send(text) { text = "" } }) { clip in
                    let spoken = try await model.transcribe(clip)
                    // While a run is still going, the words wait in the composer instead.
                    if !thread.send(spoken) { text = text.isEmpty ? spoken : text + " " + spoken }
                }.padding(.horizontal, 16).padding(.bottom, 10)
            }
            VoiceOverlay(voice: voice)
        }
        .animation(.easeOut(duration: 0.18), value: voice.active)
        .onAppear { thread.start() }
        .onDisappear { thread.stop() }
    }

    private func timestamp(_ date: Date) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        if Calendar.current.isDateInToday(date) { return "Today \(time)" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday \(time)" }
        return "\(date.formatted(.dateTime.month(.abbreviated).day())) \(time)"
    }

    private func userBubble(_ text: String) -> some View {
        HStack {
            Spacer(minLength: 48)
            Text(text).font(.system(size: 17)).lineSpacing(5)
                .padding(.horizontal, 16).padding(.vertical, 12)
                .background(InstantStyle.border.opacity(0.45), in: RoundedRectangle(cornerRadius: 22))
                .textSelection(.enabled)
                .accessibilityIdentifier("task.message.user")
        }
    }

    private func assistantText(_ text: String) -> some View {
        AssistantMarkdown(text: text)
            .font(.system(size: 17)).lineSpacing(5).frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("task.message.assistant")
    }
}

// MARK: - Shared pieces

private struct TaskTopBar: View {
    let title: String
    var subtitle: TaskThreadModel?
    var onBack: () -> Void
    var body: some View {
        HStack(spacing: 14) {
            CircleButton(symbol: "chevron.left", label: "Back", action: onBack).accessibilityIdentifier("task.back")
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 18, weight: .medium)).lineLimit(1)
                if let thread = subtitle { TaskStatusLabel(thread: thread) }
            }
            Spacer(minLength: 0)
        }.padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 10)
    }
}

private struct TaskStatusLabel: View {
    let thread: TaskThreadModel
    var body: some View {
        HStack(spacing: 6) {
            switch thread.status {
            case "completed": Image(systemName: "checkmark.circle"); Text("Completed")
            case "failed": Image(systemName: "exclamationmark.circle"); Text("Failed")
            case "cancelled": Image(systemName: "xmark.circle"); Text("Cancelled")
            default: ProgressView().controlSize(.mini); Text("In progress")
            }
        }.font(.system(size: 15)).foregroundStyle(InstantStyle.muted).accessibilityElement(children: .combine)
            .accessibilityIdentifier("task.status")
    }
}
