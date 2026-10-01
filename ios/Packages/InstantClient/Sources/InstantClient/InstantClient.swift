import Foundation

/// Supplies a bearer token for every request. The real app injects a
/// Clerk-backed provider; local development injects a static fixed identity.
/// InstantClient itself has no dependency on Clerk or any auth SDK.
public protocol InstantTokenProvider: Sendable {
    func token() async throws -> String
    /// Refresh only the credential rejected by the server. Providers can reuse
    /// a newer token when concurrent requests have already refreshed it.
    func refreshToken(rejectedToken: String) async throws -> String
}

public extension InstantTokenProvider {
    func refreshToken(rejectedToken: String) async throws -> String { try await token() }
}

/// A fixed token — the local-dev fixture identity, or any pre-obtained token.
public struct StaticInstantToken: InstantTokenProvider {
    private let value: String
    public init(_ value: String) { self.value = value }
    public func token() async throws -> String { value }
}

public struct InstantAPIError: Error, Decodable, Equatable, Sendable {
    public let statusCode: Int
    public let code: String
    public let message: String
    public let retryable: Bool
    public let requestId: String?
}

public enum InstantClientError: Error, Sendable {
    case invalidResponse
    case invalidIdentifier
    case unexpectedHTTPStatus(Int)
}

/// Native background tasks may replace their Authorization header just before
/// sending. Carry the actual rejected credential back to the shared refresh
/// policy, rather than invalidating the token in an older request snapshot.
public struct InstantAuthorizationError: Error, Sendable, CustomStringConvertible {
    let rejectedToken: String?
    public var description: String { "HTTP 401" }
    public init(request: URLRequest?) {
        let header = request?.value(forHTTPHeaderField: "Authorization")
        rejectedToken = header?.hasPrefix("Bearer ") == true ? String(header!.dropFirst(7)) : nil
    }
}

public struct RegisteredDevice: Decodable, Sendable { public let deviceId: String }
public struct MessageReceipt: Decodable, Equatable, Sendable {
    public let messageId: String
    public let submissionId: String
}
/// A voice message accepted after server transcription: the receipt plus the text it became.
public struct VoiceMessageReceipt: Decodable, Equatable, Sendable {
    public let messageId: String
    public let submissionId: String
    public let text: String
}
public struct Submission: Decodable, Sendable {
    public let submissionId: String
    public let messageId: String
    public let status: String
    public let resultCount: Int
    public let subscriberCount: Int
}
public struct ConversationMessage: Decodable, Sendable {
    public let id: String
    public let role: String
    public let sequence: Int
    public let text: String
    public let status: String
    public let createdAt: String
    /// Files delivered with an assistant reply, from its `data-instant-file` parts.
    public let files: [DeliveredFile]

    private enum CodingKeys: String, CodingKey { case id, role, sequence, text, status, createdAt, parts }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        role = try container.decode(String.self, forKey: .role)
        sequence = try container.decode(Int.self, forKey: .sequence)
        text = try container.decode(String.self, forKey: .text)
        status = try container.decode(String.self, forKey: .status)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        let parts = try container.decodeIfPresent([JSONValue].self, forKey: .parts) ?? []
        var files: [DeliveredFile] = []
        for part in parts where part["type"]?.string == "data-instant-file" {
            if let file = DeliveredFile(part["data"]), !files.contains(where: { $0.fileId == file.fileId }) { files.append(file) }
        }
        self.files = files
    }
}
public struct ActiveSubmission: Decodable, Sendable {
    public let submissionId: String
    public let messageId: String
    public let status: String
}
public struct ConversationPage: Decodable, Sendable {
    public let conversationId: String
    public let messages: [ConversationMessage]
    public let activeSubmissions: [ActiveSubmission]
    public let hasMore: Bool
    public let nextAfterSequence: Int
}
public struct TaskSummary: Decodable, Equatable, Sendable, Identifiable {
    public let taskId: String
    public let conversationId: String
    public let title: String
    /// queued, in_progress, completed, failed or cancelled — derived from the latest run.
    public let status: String
    public let createdAt: String
    /// Latest task change, including follow-ups and execution updates. Optional for older servers.
    public let updatedAt: String?
    public let lastRunStartedAt: String?
    public let lastRunCompletedAt: String?
    public var id: String { taskId }
}
public struct TaskReceipt: Decodable, Equatable, Sendable {
    public let taskId: String
    public let conversationId: String
    public let messageId: String
    public let submissionId: String
}
public struct TaskConversationPage: Decodable, Sendable {
    public let taskId: String
    public let title: String
    public let conversationId: String
    public let messages: [ConversationMessage]
    public let activeSubmissions: [ActiveSubmission]
    public let hasMore: Bool
    public let nextAfterSequence: Int
}
public struct PendingInvocation: Decodable, Sendable {
    public let invocationId: String
    public let toolCallId: String
    public let deviceId: String
    public let expiresAt: String
    public let toolName: String
    public let input: JSONValue
}
public struct ToolClaim: Decodable, Equatable, Sendable {
    public let executionId: String
    public let expiresAt: String
}
public struct ToolResultReceipt: Decodable, Equatable, Sendable {
    public let accepted: Bool
    public let duplicate: Bool
}

public struct MessageClientContext: Codable, Equatable, Sendable {
    public let timeZone: String
    public let currentDate: String
    public init(timeZone: String, currentDate: String) {
        self.timeZone = timeZone
        self.currentDate = currentDate
    }
}

/// ICA commands and UI stream transport. No Rebyte organization key belongs here.
public struct InstantClient: Sendable {
    private let baseURL: URL
    private let tokenProvider: any InstantTokenProvider
    private let session: URLSession

    public init(baseURL: URL, tokenProvider: any InstantTokenProvider, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.tokenProvider = tokenProvider
        self.session = session
    }

    public init(baseURL: URL, bearerToken: String, session: URLSession = .shared) {
        self.init(baseURL: baseURL, tokenProvider: StaticInstantToken(bearerToken), session: session)
    }

    public func registerDevice(installationId: String, tools: [String] = ["instant_test_echo"]) async throws -> RegisteredDevice {
        try await send("POST", ["devices", "register"], body: .object([
            "installationId": .string(installationId), "tools": .array(tools.map(JSONValue.string)),
        ]))
    }

    public func sendMessage(clientMessageId: String, text: String, scenario: String? = nil, deviceId: String? = nil, clientContext: MessageClientContext? = nil) async throws -> MessageReceipt {
        var body: [String: JSONValue] = ["clientMessageId": .string(clientMessageId), "text": .string(text)]
        if let scenario { body["scenario"] = .string(scenario) }
        if let deviceId { body["deviceId"] = .string(deviceId) }
        if let clientContext {
            body["clientContext"] = .object(["timeZone": .string(clientContext.timeZone), "currentDate": .string(clientContext.currentDate)])
        }
        return try await send("POST", ["conversation", "messages"], body: .object(body))
    }

    /// Upload a hold-to-talk clip; the server transcribes it, accepts the text as this message and
    /// starts the reply. Retrying the same `clientMessageId` returns the original text.
    public func sendVoiceMessage(clientMessageId: String, audio: Data, mimeType: String, deviceId: String? = nil, clientContext: MessageClientContext? = nil) async throws -> VoiceMessageReceipt {
        var body: [String: JSONValue] = ["clientMessageId": .string(clientMessageId), "audio": .string(audio.base64EncodedString()), "mimeType": .string(mimeType)]
        if let deviceId { body["deviceId"] = .string(deviceId) }
        if let clientContext {
            body["clientContext"] = .object(["timeZone": .string(clientContext.timeZone), "currentDate": .string(clientContext.currentDate)])
        }
        return try await send("POST", ["conversation", "voice-messages"], body: .object(body))
    }

    /// Transcribe a clip without sending it anywhere.
    public func transcribeVoice(audio: Data, mimeType: String) async throws -> String {
        struct Transcription: Decodable { let text: String }
        let result: Transcription = try await send("POST", ["voice", "transcriptions"], body: .object(["audio": .string(audio.base64EncodedString()), "mimeType": .string(mimeType)]))
        return result.text
    }

    public func submission(_ id: String) async throws -> Submission {
        try await send("GET", ["submissions", id])
    }

    public func conversation(afterSequence: Int = 0, limit: Int = 100) async throws -> ConversationPage {
        try await send("GET", ["conversation"], query: [
            URLQueryItem(name: "afterSequence", value: String(afterSequence)),
            URLQueryItem(name: "limit", value: String(limit)),
        ])
    }

    public func listeningSegments(from: Date, to: Date) async throws -> [ListeningSegment] {
        struct Page: Decodable { let segments: [ListeningSegment] }
        let formatter = ISO8601DateFormatter()
        let page: Page = try await send("GET", ["listening", "segments"], query: [
            URLQueryItem(name: "from", value: formatter.string(from: from)),
            URLQueryItem(name: "to", value: formatter.string(from: to)),
        ])
        return page.segments
    }

    public func listeningHistory(cursor: String? = nil, limit: Int = 30, before: Date? = nil, newer: Bool = false) async throws -> ListeningHistoryPage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        if let before { query.append(URLQueryItem(name: "before", value: ISO8601DateFormatter().string(from: before))) }
        if newer { query.append(URLQueryItem(name: "direction", value: "newer")) }
        return try await send("GET", ["listening", "segments"], query: query)
    }

    public func listeningCalendar(timeZone: String) async throws -> ListeningCalendar {
        try await send("GET", ["listening", "calendar"], query: [URLQueryItem(name: "timeZone", value: timeZone)])
    }

    public func listeningTimeline(timeZone: String) async throws -> ListeningTimeline {
        try await send("GET", ["listening", "timeline"], query: [URLQueryItem(name: "timeZone", value: timeZone)])
    }

    public func listeningRecords(ids: [String]) async throws -> [ListeningSegment] {
        guard !ids.isEmpty else { return [] }
        struct Page: Decodable { let segments: [ListeningSegment] }
        let page: Page = try await send("GET", ["listening", "segments"], query: [URLQueryItem(name: "ids", value: ids.joined(separator: ","))])
        return page.segments
    }

    /// The stable ID and exact metadata must be reused after a lost upload response.
    public func uploadListeningSegment(id: String, startedAt: Date, endedAt: Date, audio: Data) async throws -> ListeningSegment {
        var request = try await listeningUploadRequest(id: id, startedAt: startedAt, endedAt: endedAt)
        request.httpBody = audio
        request.timeoutInterval = 60
        let (data, response) = try await authorizedData(for: request)
        guard let http = response as? HTTPURLResponse else { throw InstantClientError.invalidResponse }
        guard http.statusCode == 202 else { throw decodeError(data: data, statusCode: http.statusCode) }
        return try JSONDecoder().decode(ListeningSegment.self, from: data)
    }

    /// Authenticated request for native background file transfer. No audio body or
    /// stored credentials; obtain a fresh token when scheduling each attempt.
    public func listeningUploadRequest(id: String, startedAt: Date, endedAt: Date) async throws -> URLRequest {
        var request = try await makeRequest("POST", ["listening", "segments"])
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        request.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        request.setValue(id, forHTTPHeaderField: "X-Client-Segment-Id")
        request.setValue(formatter.string(from: startedAt), forHTTPHeaderField: "X-Recording-Started-At")
        request.setValue(formatter.string(from: endedAt), forHTTPHeaderField: "X-Recording-Ended-At")
        request.timeoutInterval = 60
        return request
    }

    public func listeningBatchUploadRequest() async throws -> URLRequest {
        var request = try await makeRequest("POST", ["listening", "batches"])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 60
        return request
    }

    public func uploadListeningBatch(_ payload: Data, allowsCellularAccess: Bool = true) async throws -> ListeningBatchReceipt {
        var request = try await listeningBatchUploadRequest(); request.httpBody = payload
        request.allowsCellularAccess = allowsCellularAccess
        let (data, response) = try await authorizedData(for: request)
        guard let http = response as? HTTPURLResponse else { throw InstantClientError.invalidResponse }
        guard http.statusCode == 202 else { throw decodeError(data: data, statusCode: http.statusCode) }
        return try JSONDecoder().decode(ListeningBatchReceipt.self, from: data)
    }

    /// The API receives metadata only. Audio is uploaded to the returned S3 URL separately.
    public func prepareListeningUpload(_ manifest: Data) async throws -> ListeningUploadTicket {
        var request = try await makeRequest("POST", ["listening", "uploads"])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = manifest
        let (data, response) = try await authorizedData(for: request)
        guard let http = response as? HTTPURLResponse else { throw InstantClientError.invalidResponse }
        guard http.statusCode == 200 else { throw decodeError(data: data, statusCode: http.statusCode) }
        return try JSONDecoder().decode(ListeningUploadTicket.self, from: data)
    }

    public func completeListeningUpload(_ batchId: String) async throws -> ListeningBatchReceipt {
        try await send("POST", ["listening", "uploads", batchId, "complete"], body: .object([:]))
    }

    public func retryListeningBatch(_ id: String) async throws {
        struct Receipt: Decodable { let status: String }
        let _: Receipt = try await send("POST", ["listening", "batches", id, "retry"])
    }

    public func setListeningLocationLabel(_ id: String, label: String?) async throws -> ListeningSegment {
        struct Response: Decodable { let segment: ListeningSegment }
        let response: Response = try await send("PATCH", ["listening", "segments", id, "location"],
                                               body: .object(["label": label.map(JSONValue.string) ?? .null]))
        return response.segment
    }

    public func deleteListeningSegment(_ id: String) async throws {
        struct Receipt: Decodable { let status: String }
        let _: Receipt = try await send("DELETE", ["listening", "segments", id])
    }

    public func tasks() async throws -> [TaskSummary] {
        struct Response: Decodable { let tasks: [TaskSummary] }
        let response: Response = try await send("GET", ["tasks"])
        return response.tasks
    }

    public func todaySettings() async throws -> TodaySettingsResponse {
        try await send("GET", ["today", "settings"])
    }
    public func configureToday(timeZone: String, locale: String, displayName: String, slots: [TodaySlot]? = nil, location: TodayLocation? = nil, clearLocation: Bool = false) async throws -> TodaySettingsResponse {
        var body: [String: JSONValue] = ["timeZone": .string(timeZone), "locale": .string(locale), "displayName": .string(displayName)]
        if let slots {
            body["slots"] = .array(slots.map { .object(["id": .string($0.id), "label": .string($0.label), "hour": .number(Double($0.hour)), "enabled": .bool($0.enabled)]) })
        }
        if clearLocation { body["location"] = .null }
        else if let location {
            var fields: [String: JSONValue] = ["city": .string(location.city), "country": .string(location.country), "capturedAt": .string(location.capturedAt)]
            if let source = location.source { fields["source"] = .string(source.rawValue) }
            body["location"] = .object(fields)
        }
        return try await send("PUT", ["today", "settings"], body: .object(body))
    }
    public func todayBriefs(cursor: String? = nil, date: String? = nil) async throws -> TodayPage {
        var query = [URLQueryItem(name: "limit", value: "10")]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        if let date { query.append(URLQueryItem(name: "date", value: date)) }
        return try await send("GET", ["today", "briefs"], query: query)
    }
    public func todayBrief(_ id: String) async throws -> TodayBrief { try await send("GET", ["today", "briefs", id]) }
    public func todaySource(briefID: String, recordID: String) async throws -> TodaySource { try await send("GET", ["today", "briefs", briefID, "sources", recordID]) }
    public func deleteTodayBrief(_ id: String) async throws {
        struct Response: Decodable { let status: String }
        let _: Response = try await send("DELETE", ["today", "briefs", id])
    }

    public func memorySummary() async throws -> MemorySummary { try await send("GET", ["memories", "summary"]) }
    public func memories(category: String? = nil, cursor: String? = nil, limit: Int = 30) async throws -> MemoryPage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let category { query.append(URLQueryItem(name: "category", value: category)) }
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await send("GET", ["memories"], query: query)
    }
    public func deleteMemory(_ id: String) async throws {
        struct Response: Decodable { let status: String }
        let _: Response = try await send("DELETE", ["memories", id])
    }

    /// Retrying with the same clientMessageId returns the same task instead of creating another.
    public func createTask(clientMessageId: String, text: String, clientContext: MessageClientContext? = nil) async throws -> TaskReceipt {
        try await send("POST", ["tasks"], body: .object(messageBody(clientMessageId: clientMessageId, text: text, clientContext: clientContext)))
    }

    public func taskConversation(_ taskId: String, afterSequence: Int = 0, limit: Int = 100) async throws -> TaskConversationPage {
        try await send("GET", ["tasks", taskId, "conversation"], query: [
            URLQueryItem(name: "afterSequence", value: String(afterSequence)),
            URLQueryItem(name: "limit", value: String(limit)),
        ])
    }

    public func sendTaskMessage(_ taskId: String, clientMessageId: String, text: String, clientContext: MessageClientContext? = nil) async throws -> MessageReceipt {
        try await send("POST", ["tasks", taskId, "messages"], body: .object(messageBody(clientMessageId: clientMessageId, text: text, clientContext: clientContext)))
    }

    private func messageBody(clientMessageId: String, text: String, clientContext: MessageClientContext?) -> [String: JSONValue] {
        var body: [String: JSONValue] = ["clientMessageId": .string(clientMessageId), "text": .string(text)]
        if let clientContext {
            body["clientContext"] = .object(["timeZone": .string(clientContext.timeZone), "currentDate": .string(clientContext.currentDate)])
        }
        return body
    }

    public func profile() async throws -> AccountProfile {
        try await send("GET", ["profile"])
    }

    /// Partial update; omitted fields are unchanged. `onboarded` can only become true.
    public func updateProfile(assistantName: String? = nil, avatarIndex: Int? = nil, onboarded: Bool? = nil) async throws -> AccountProfile {
        var body: [String: JSONValue] = [:]
        if let assistantName { body["assistantName"] = .string(assistantName) }
        if let avatarIndex { body["avatarIndex"] = .number(Double(avatarIndex)) }
        if let onboarded { body["onboarded"] = .bool(onboarded) }
        return try await send("PATCH", ["profile"], body: .object(body))
    }

    public func connectors() async throws -> [ConnectorSummary] {
        let list: ConnectorList = try await send("GET", ["connectors"])
        return list.connectors
    }

    public func connectorStatus(_ toolkit: String) async throws -> ConnectorStatus {
        try await send("GET", ["connectors", toolkit])
    }

    public func connectConnector(_ toolkit: String) async throws -> ConnectorConnectResponse {
        try await send("POST", ["connectors", toolkit, "connect"], body: .object([:]))
    }

    public func refreshConnector(_ toolkit: String) async throws -> ConnectorStatus {
        try await send("POST", ["connectors", toolkit, "refresh"], body: .object([:]))
    }

    public func disconnectConnector(_ toolkit: String) async throws -> ConnectorStatus {
        try await send("DELETE", ["connectors", toolkit])
    }

    /// Explicit cancellation is separate from cancelling an SSE subscription.
    public func cancelSubmission(_ id: String) async throws -> Submission {
        try await send("POST", ["submissions", id, "cancel"], body: .object([:]))
    }

    public func pendingInvocations(deviceId: String) async throws -> [PendingInvocation] {
        struct Response: Decodable { let invocations: [PendingInvocation] }
        let response: Response = try await send("GET", ["devices", deviceId, "tool-invocations"], query: [URLQueryItem(name: "status", value: "pending")])
        return response.invocations
    }

    public func claimInvocation(_ id: String, deviceId: String) async throws -> ToolClaim {
        try await send("POST", ["device-tool-invocations", id, "claim"], body: .object(["deviceId": .string(deviceId)]))
    }

    public func submitResult(_ id: String, deviceId: String, executionId: String, success: Bool, output: JSONValue? = nil, error: String? = nil) async throws -> ToolResultReceipt {
        var body: [String: JSONValue] = [
            "deviceId": .string(deviceId), "executionId": .string(executionId), "success": .bool(success),
        ]
        if let output { body["output"] = output }
        if let error { body["error"] = .string(error) }
        return try await send("POST", ["device-tool-invocations", id, "result"], body: .object(body))
    }

    /// Each subscription uses a fresh reducer. Cancel its consuming Task to close
    /// the HTTP subscription; this never invokes the server's cancel command.
    public func stream(submissionId: String) -> AsyncThrowingStream<UIMessageState, any Error> {
        AsyncThrowingStream(bufferingPolicy: .bufferingNewest(16)) { continuation in
            let task = Task {
                do {
                    var request = try await makeRequest("GET", ["submissions", submissionId, "stream"])
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await retryingAuthorization(for: request) { request in
                        let (bytes, response) = try await session.bytes(for: request)
                        if (response as? HTTPURLResponse)?.statusCode == 401 {
                            // Drain the small rejection before replacing this subscription.
                            var data = Data()
                            for try await byte in bytes {
                                data.append(byte)
                                if data.count > 65_536 { break }
                            }
                            throw decodeError(data: data, statusCode: 401)
                        }
                        return (bytes, response)
                    }
                    guard let http = response as? HTTPURLResponse else { throw InstantClientError.invalidResponse }
                    guard (200..<300).contains(http.statusCode) else {
                        var data = Data()
                        for try await byte in bytes {
                            data.append(byte)
                            if data.count > 65_536 { break }
                        }
                        throw decodeError(data: data, statusCode: http.statusCode)
                    }
                    guard http.value(forHTTPHeaderField: "x-vercel-ai-ui-message-stream") == "v1",
                          http.value(forHTTPHeaderField: "content-type")?.lowercased().contains("text/event-stream") == true else {
                        throw StreamProtocolError.unsupportedStream
                    }
                    var parser = SSEParser()
                    var reducer = UIMessageReducer()
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        if let event = try parser.feed(byte: byte) {
                            let state = try reducer.consume(event)
                            continuation.yield(state)
                            if state.done { break }
                        }
                    }
                    try reducer.validateEOF()
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    func send<Response: Decodable>(_ method: String, _ path: [String], body: JSONValue? = nil, query: [URLQueryItem] = []) async throws -> Response {
        var request = try await makeRequest(method, path, query: query)
        if let body { request.httpBody = try JSONEncoder().encode(body) }
        let (data, response) = try await authorizedData(for: request)
        guard let http = response as? HTTPURLResponse else { throw InstantClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw decodeError(data: data, statusCode: http.statusCode) }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    /// Used by HTTP, SSE and native file uploads. A 401 is rejected before the
    /// server executes a command, so retry the exact body/IDs once, never other
    /// failures or an already-started stream. Cancellation must not start a retry.
    public func retryingAuthorization<Value: Sendable>(for request: URLRequest,
        operation: @Sendable (URLRequest) async throws -> Value) async throws -> Value {
        do { return try await operation(request) }
        catch {
            let unauthorized = (error as? InstantAPIError)?.statusCode == 401
                || error is InstantAuthorizationError
                || { if case InstantClientError.unexpectedHTTPStatus(401) = error { return true }; return false }()
            guard unauthorized else { throw error }
            try Task.checkCancellation()
            guard let header = request.value(forHTTPHeaderField: "Authorization"), header.hasPrefix("Bearer ") else { throw error }
            let rejected = (error as? InstantAuthorizationError)?.rejectedToken ?? String(header.dropFirst(7))
            let token = try await tokenProvider.refreshToken(rejectedToken: rejected)
            try Task.checkCancellation()
            guard token != rejected else { throw error }
            var retry = request
            retry.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            return try await operation(retry)
        }
    }

    private func authorizedData(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await retryingAuthorization(for: request) { request in
            let (data, response) = try await session.data(for: request)
            if (response as? HTTPURLResponse)?.statusCode == 401 {
                throw decodeError(data: data, statusCode: 401)
            }
            return (data, response)
        }
    }

    /// Downloads a delivered file once into `directory/<fileId>/<name>` and returns its local URL.
    /// The caller owns the directory and clears it when the account changes.
    public func downloadFile(_ file: DeliveredFile, into directory: URL, validateAccount: @Sendable () async throws -> Void = {}) async throws -> URL {
        guard file.fileId.range(of: "^[A-Za-z0-9_-]{1,256}$", options: .regularExpression) != nil else { throw InstantClientError.invalidIdentifier }
        guard (0...104_857_600).contains(file.sizeBytes) else { throw InstantClientError.invalidResponse }
        try Task.checkCancellation()
        try await validateAccount()
        let folder = directory.appendingPathComponent(file.fileId, isDirectory: true)
        let destination = folder.appendingPathComponent(file.localName)
        if FileManager.default.fileExists(atPath: destination.path) {
            let bytes = try FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? NSNumber
            if bytes?.intValue == file.sizeBytes { return destination }
            try FileManager.default.removeItem(at: destination)
        }
        var request = try await makeRequest("GET", ["files", file.fileId])
        request.timeoutInterval = 120
        request.setValue(nil, forHTTPHeaderField: "Content-Type")
        let downloaded = try await retryingAuthorization(for: request) { request in
            let (location, response) = try await session.download(for: request)
            guard let http = response as? HTTPURLResponse else { throw InstantClientError.invalidResponse }
            guard (200..<300).contains(http.statusCode) else {
                let body = (try? Data(contentsOf: location)) ?? Data()
                try? FileManager.default.removeItem(at: location)
                throw decodeError(data: body, statusCode: http.statusCode)
            }
            // The system deletes its temporary file when this closure returns.
            let staged = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.moveItem(at: location, to: staged)
            return staged
        }
        do {
            try Task.checkCancellation()
            try await validateAccount()
            let bytes = try FileManager.default.attributesOfItem(atPath: downloaded.path)[.size] as? NSNumber
            guard bytes?.intValue == file.sizeBytes else { throw InstantClientError.invalidResponse }
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: destination.path) { try? FileManager.default.removeItem(at: downloaded); return destination }
            try FileManager.default.moveItem(at: downloaded, to: destination)
        } catch {
            try? FileManager.default.removeItem(at: downloaded)
            throw error
        }
        return destination
    }

    private func makeRequest(_ method: String, _ path: [String], query: [URLQueryItem] = []) async throws -> URLRequest {
        let safe = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        guard path.allSatisfy({ !$0.isEmpty && $0.unicodeScalars.allSatisfy(safe.contains) }) else {
            throw InstantClientError.invalidIdentifier
        }
        var url = baseURL.appendingPathComponent("api/v1")
        for part in path { url.appendPathComponent(part) }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw InstantClientError.invalidResponse }
        if !query.isEmpty { components.queryItems = query }
        guard let requestURL = components.url else { throw InstantClientError.invalidResponse }
        var request = URLRequest(url: requestURL)
        request.httpMethod = method
        request.timeoutInterval = 15
        let token = try await tokenProvider.token()
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    private func decodeError(data: Data, statusCode: Int) -> any Error {
        struct Envelope: Decodable {
            struct Detail: Decodable { let code: String; let message: String; let retryable: Bool }
            let error: Detail
            let requestId: String?
        }
        guard let body = try? JSONDecoder().decode(Envelope.self, from: data) else {
            return InstantClientError.unexpectedHTTPStatus(statusCode)
        }
        return InstantAPIError(statusCode: statusCode, code: body.error.code, message: body.error.message, retryable: body.error.retryable, requestId: body.requestId)
    }
}
