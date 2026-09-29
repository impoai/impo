import Foundation
import InstantClient
import Observation

/// One row in the Tasks list, from the server in live mode or local in offline Demo.
struct TaskItem: Identifiable, Equatable, Codable {
    let id: String
    var title: String
    var status: String
    var createdAt: Date
    var runStartedAt: Date?
    var runCompletedAt: Date?
    var updatedAt: Date?

    var isRunning: Bool { status == "queued" || status == "in_progress" }

    var lastModifiedAt: Date { updatedAt ?? runCompletedAt ?? runStartedAt ?? createdAt }

    func lastModifiedLabel(now: Date = Date()) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(lastModifiedAt)))
        if seconds < 60 { return "Just now" }
        if seconds < 3600 { return "\(seconds / 60)m ago" }
        if seconds < 86_400 { return "\(seconds / 3600)h ago" }
        if seconds < 604_800 { return "\(seconds / 86_400)d ago" }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.unitsStyle = .abbreviated
        formatter.dateTimeStyle = .numeric
        return formatter.localizedString(for: lastModifiedAt, relativeTo: now)
    }
}

/// Server timestamps come with or without fractional seconds.
private func parseDate(_ value: String?) -> Date? {
    guard let value else { return nil }
    return (try? Date(value, strategy: .iso8601.year().month().day().timeZone(separator: .omitted).time(includingFractionalSeconds: true)))
        ?? (try? Date(value, strategy: .iso8601))
}

private func currentClientContext() -> MessageClientContext {
    MessageClientContext(timeZone: TimeZone.current.identifier, currentDate: ISO8601DateFormatter().string(from: Date()))
}

@MainActor @Observable
final class TasksModel {
    var tasks: [TaskItem] = []
    var loadError: String?
    /// The New task or task conversation page currently shown over the Tasks tab.
    var route: TaskRoute?
    /// Offline Demo keeps its tasks on this device (cleared by Reset Demo with the other `instant.` keys).
    @ObservationIgnored private var demoThreads: [String: [ChatMessage]] = [:] { didSet { saveDemo() } }
    @ObservationIgnored private var demoTasks: [TaskItem] = []
    private static let demoKey = "instant.demoTasks"
    private struct DemoStore: Codable { var tasks: [TaskItem]; var threads: [String: [ChatMessage]] }

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.demoKey),
           let store = try? JSONDecoder().decode(DemoStore.self, from: data) {
            demoTasks = store.tasks
            demoThreads = store.threads
        }
    }

    private func saveDemo() {
        demoTasks = tasks.filter { demoThreads[$0.id] != nil }
        UserDefaults.standard.set(try? JSONEncoder().encode(DemoStore(tasks: demoTasks, threads: demoThreads)), forKey: Self.demoKey)
    }

    func refresh(using app: AppModel) async {
        guard let api = app.liveClient() else {
            // After Reset Demo the stored tasks are gone even though this model outlived it.
            if UserDefaults.standard.data(forKey: Self.demoKey) == nil { demoThreads = [:]; demoTasks = [] }
            tasks = demoTasks
            return
        }
        do {
            let summaries = try await api.tasks()
            tasks = summaries.map { summary in
                TaskItem(id: summary.taskId, title: summary.title, status: summary.status,
                         createdAt: parseDate(summary.createdAt) ?? Date(),
                         runStartedAt: parseDate(summary.lastRunStartedAt), runCompletedAt: parseDate(summary.lastRunCompletedAt),
                         updatedAt: parseDate(summary.updatedAt))
            }
            loadError = nil
        } catch {
            loadError = "Couldn't load your tasks. Pull to try again."
        }
    }

    /// Creates a task and returns its ID. A retried create reuses the same clientMessageId on the server.
    func create(_ raw: String, using app: AppModel) async throws -> String {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 4000 else { throw TaskInputError.invalidLength }
        guard let api = app.liveClient() else {
            let id = UUID().uuidString
            let now = Date()
            tasks.insert(TaskItem(id: id, title: text, status: "in_progress", createdAt: now, runStartedAt: now), at: 0)
            demoThreads[id] = [ChatMessage(role: "user", text: text)]
            return id
        }
        let receipt = try await api.createTask(clientMessageId: UUID().uuidString, text: text, clientContext: currentClientContext())
        let now = Date()
        tasks.removeAll { $0.id == receipt.taskId }
        tasks.insert(TaskItem(id: receipt.taskId, title: text, status: "queued", createdAt: now, runStartedAt: now), at: 0)
        return receipt.taskId
    }

    func thread(for taskId: String, app: AppModel) -> TaskThreadModel {
        let title = tasks.first { $0.id == taskId }?.title ?? ""
        if let api = app.liveClient() { return TaskThreadModel(taskId: taskId, title: title, backend: .live(api)) }
        return TaskThreadModel(taskId: taskId, title: title, backend: .demo(self))
    }

    // MARK: Offline Demo

    fileprivate func demoMessages(_ taskId: String) -> [ChatMessage] { demoThreads[taskId] ?? [] }

    fileprivate func demoReply(_ taskId: String, to text: String?) async -> [ChatMessage] {
        if let text { demoThreads[taskId, default: []].append(ChatMessage(role: "user", text: text)) }
        setStatus(taskId, "in_progress", started: Date())
        try? await Task.sleep(for: .milliseconds(900))
        // A reopened page can start a second follower; only an unanswered request gets a reply.
        if !Task.isCancelled, demoThreads[taskId]?.last?.role == "user" {
            demoThreads[taskId, default: []].append(ChatMessage(role: "assistant",
                text: "This is an offline Demo, so this task can't run yet. Sign in to run it for real."))
            setStatus(taskId, "completed", completed: Date())
        }
        return demoThreads[taskId] ?? []
    }

    fileprivate func demoCreatedAt(_ taskId: String) -> Date? { tasks.first { $0.id == taskId }?.createdAt }

    fileprivate func setStatus(_ taskId: String, _ status: String, started: Date? = nil, completed: Date? = nil) {
        guard let index = tasks.firstIndex(where: { $0.id == taskId }) else { return }
        tasks[index].status = status
        tasks[index].updatedAt = Date()
        if let started { tasks[index].runStartedAt = started; tasks[index].runCompletedAt = nil }
        if let completed { tasks[index].runCompletedAt = completed }
        if demoThreads[taskId] != nil { saveDemo() }
    }
}

enum TaskInputError: LocalizedError {
    case invalidLength
    var errorDescription: String? { "Describe the task in 4,000 characters or fewer." }
}

/// The conversation inside one task: loads its history, follows active runs, and sends follow-ups.
@MainActor @Observable
final class TaskThreadModel {
    enum Backend { case live(InstantClient), demo(TasksModel) }

    let taskId: String
    var title: String
    var messages: [ChatMessage] = []
    var status = "queued"
    var startedAt: Date?
    var error: String?
    /// Intermediate steps of the run in progress; shown while it runs, then dropped.
    var steps: [StreamStep] = []
    var isRunning: Bool { status == "queued" || status == "in_progress" }
    @ObservationIgnored private let backend: Backend
    @ObservationIgnored private var followTask: Task<Void, Never>?

    init(taskId: String, title: String, backend: Backend) {
        self.taskId = taskId
        self.title = title
        self.backend = backend
    }

    func start() {
        followTask?.cancel()
        followTask = Task { await follow() }
    }

    func stop() {
        // Leaving the page only closes the subscription; the server keeps running the task.
        followTask?.cancel()
        followTask = nil
    }

    func send(_ raw: String) -> Bool {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isRunning, text.utf16.count <= 32_768 else { return false }
        error = nil
        switch backend {
        case .demo(let tasks):
            messages.append(ChatMessage(role: "user", text: text))
            status = "in_progress"
            followTask = Task {
                messages = await tasks.demoReply(taskId, to: text)
                status = "completed"
            }
        case .live(let api):
            let clientID = UUID().uuidString
            messages.append(ChatMessage(id: clientID, role: "user", text: text))
            status = "queued"
            followTask?.cancel()
            followTask = Task {
                do {
                    _ = try await api.sendTaskMessage(taskId, clientMessageId: clientID, text: text, clientContext: currentClientContext())
                    await follow()
                } catch {
                    if !Task.isCancelled { self.error = "Couldn't send this message. Check your connection and try again."; status = "failed" }
                }
            }
        }
        return true
    }

    private func follow() async {
        switch backend {
        case .demo(let tasks):
            startedAt = tasks.demoCreatedAt(taskId)
            messages = tasks.demoMessages(taskId)
            if messages.last?.role == "user" {
                status = "in_progress"
                messages = await tasks.demoReply(taskId, to: nil)
            }
            if !Task.isCancelled { status = "completed" }
        case .live(let api):
            var failures = 0
            while !Task.isCancelled {
                do {
                    let page = try await loadAll(api)
                    failures = 0
                    error = nil
                    guard let active = page.active.first else { status = page.finalStatus; return }
                    status = "in_progress"
                    for try await state in api.stream(submissionId: active.submissionId) {
                        if Task.isCancelled { return }
                        if let id = state.messageId, !state.text.isEmpty {
                            if let index = messages.firstIndex(where: { $0.id == id }) { messages[index].text = state.text }
                            else { messages.append(ChatMessage(id: id, role: "assistant", text: state.text)) }
                        }
                        steps = state.done ? [] : state.steps
                        if state.done { break }
                    }
                    steps = []
                } catch {
                    if Task.isCancelled { return }
                    // The task keeps running on the server: a dropped stream or brief outage reconnects.
                    failures += 1
                    if isTransientNetworkError(error), failures <= 3 {
                        ListeningDiagnostics.shared.record("task.stream_reconnect", ["attempt": String(failures)])
                        try? await Task.sleep(for: .seconds(1 << (failures - 1)))
                        continue
                    }
                    self.error = "Couldn't load this task. Check your connection and try again."
                    return
                }
            }
        }
    }

    private func loadAll(_ api: InstantClient) async throws -> (active: [ActiveSubmission], finalStatus: String) {
        var all: [ConversationMessage] = []
        var active: [ActiveSubmission] = []
        var after = 0
        for _ in 0..<1000 {
            let page = try await api.taskConversation(taskId, afterSequence: after)
            title = page.title
            all.append(contentsOf: page.messages)
            active = page.activeSubmissions
            if !page.hasMore { break }
            guard page.nextAfterSequence > after else { throw InstantClientError.invalidResponse }
            after = page.nextAfterSequence
        }
        all.sort { $0.sequence < $1.sequence }
        startedAt = parseDate(all.first?.createdAt)
        messages = all.filter { !$0.text.isEmpty }.map { ChatMessage(id: $0.id, role: $0.role, text: $0.text) }
        let last = all.last { $0.role == "assistant" }?.status
        let finalStatus = last == "failed" ? "failed" : last == "cancelled" ? "cancelled" : "completed"
        if finalStatus == "failed" { error = "This task couldn't be completed. You can send a follow-up to try again." }
        return (active, finalStatus)
    }
}
