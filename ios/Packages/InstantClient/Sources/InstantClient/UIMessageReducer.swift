import Foundation

public struct ToolState: Equatable, Sendable {
    public let toolCallId: String
    public let name: String
    public let input: JSONValue
    public var output: JSONValue?
    public var error: String?
}

public struct DeviceRequest: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let invocationId: String
    public let toolCallId: String
    public let deviceId: String
    public let expiresAt: String
}

/// Live progress of a running reply (a command, web search, tool, reasoning summary or note).
/// Streamed only while the reply runs and never part of the stored message.
public struct StreamStep: Equatable, Sendable, Identifiable {
    public let id: String
    public var kind: String
    public var title: String
    public var detail: String?
    /// Why a failed step failed (exit code and output tail).
    public var result: String?
    /// in_progress, completed or failed.
    public var status: String
}

/// One response reconstructs one complete message; do not append reconnects.
public struct UIMessageState: Equatable, Sendable {
    public var messageId: String?
    public var submissionId: String?
    public var status: String?
    public var text: String { textOrder.map { textParts[$0] ?? "" }.joined() }
    public var tools: [String: ToolState] = [:]
    public var deviceRequests: [String: DeviceRequest] = [:]
    /// Intermediate steps in first-seen order; updated in place by ID.
    public var steps: [StreamStep] = []
    public var errors: [String] = []
    public var aborted = false
    public var finished = false
    public var done = false
    fileprivate var textParts: [String: String] = [:]
    fileprivate var textOrder: [String] = []
    fileprivate var openText: Set<String> = []

    public init() {}
}

/// Implements the ICA v1 subset of Vercel UI Message Stream v1.
public struct UIMessageReducer: Sendable {
    public private(set) var state = UIMessageState()
    public init() {}

    @discardableResult
    public mutating func consume(_ event: String) throws -> UIMessageState {
        guard !state.done else { throw StreamProtocolError.invalidSequence("event after DONE") }
        if event == "[DONE]" {
            guard state.finished else { throw StreamProtocolError.incompleteStream }
            state.done = true
            return state
        }
        let chunk: JSONValue
        do { chunk = try JSONDecoder().decode(JSONValue.self, from: Data(event.utf8)) }
        catch { throw StreamProtocolError.malformedChunk("invalid JSON") }
        let type = try requiredString(chunk, "type")
        guard !state.finished else { throw StreamProtocolError.invalidSequence("chunk after finish") }
        if type != "start", state.messageId == nil {
            throw StreamProtocolError.invalidSequence("chunk before start")
        }
        switch type {
        case "start":
            guard state.messageId == nil else { throw StreamProtocolError.invalidSequence("duplicate start") }
            state.messageId = try requiredString(chunk, "messageId")
        case "text-start":
            let id = try requiredString(chunk, "id")
            guard state.textParts[id] == nil else { throw StreamProtocolError.invalidSequence("duplicate text block") }
            state.textParts[id] = ""
            state.textOrder.append(id)
            state.openText.insert(id)
        case "text-delta":
            let id = try requiredString(chunk, "id")
            guard state.openText.contains(id) else { throw StreamProtocolError.invalidSequence("delta without open text block") }
            state.textParts[id, default: ""] += try requiredString(chunk, "delta", allowEmpty: true)
        case "text-end":
            let id = try requiredString(chunk, "id")
            guard state.openText.remove(id) != nil else { throw StreamProtocolError.invalidSequence("end without open text block") }
        case "tool-input-available":
            let id = try requiredString(chunk, "toolCallId")
            guard let input = chunk["input"] else { throw StreamProtocolError.malformedChunk("missing input") }
            guard state.tools[id] == nil else { throw StreamProtocolError.invalidSequence("duplicate tool input") }
            state.tools[id] = ToolState(toolCallId: id, name: try requiredString(chunk, "toolName"), input: input)
        case "tool-output-available":
            let id = try requiredString(chunk, "toolCallId")
            guard var tool = state.tools[id], let output = chunk["output"] else {
                throw StreamProtocolError.invalidSequence("tool output without input")
            }
            guard tool.output == nil, tool.error == nil else { throw StreamProtocolError.invalidSequence("duplicate tool result") }
            tool.output = output
            state.tools[id] = tool
        case "tool-output-error":
            let id = try requiredString(chunk, "toolCallId")
            guard var tool = state.tools[id] else { throw StreamProtocolError.invalidSequence("tool error without input") }
            guard tool.output == nil, tool.error == nil else { throw StreamProtocolError.invalidSequence("duplicate tool result") }
            tool.error = try requiredString(chunk, "errorText")
            state.tools[id] = tool
        case "data-instant-submission":
            guard let data = chunk["data"], data["schemaVersion"] == .number(1) else {
                throw StreamProtocolError.malformedChunk("unsupported submission schema")
            }
            let id = try requiredString(data, "submissionId")
            if let existing = state.submissionId, existing != id {
                throw StreamProtocolError.invalidSequence("submission ID changed")
            }
            state.submissionId = id
            state.status = try requiredString(data, "status")
        case "data-instant-step":
            // Optional and transient: a malformed step is ignored rather than failing the reply.
            guard let id = chunk["id"]?.string, let data = chunk["data"], data["schemaVersion"] == .number(1),
                  let kind = data["kind"]?.string, let title = data["title"]?.string, let status = data["status"]?.string else { break }
            let step = StreamStep(id: id, kind: kind, title: title, detail: data["detail"]?.string, result: data["result"]?.string, status: status)
            if let index = state.steps.firstIndex(where: { $0.id == id }) { state.steps[index] = step } else { state.steps.append(step) }
        case "data-instant-device-request":
            guard let data = chunk["data"] else { throw StreamProtocolError.malformedChunk("missing request") }
            let request: DeviceRequest
            do { request = try JSONDecoder().decode(DeviceRequest.self, from: JSONEncoder().encode(data)) }
            catch { throw StreamProtocolError.malformedChunk("invalid device request") }
            guard request.schemaVersion == 1, !request.invocationId.isEmpty,
                  !request.toolCallId.isEmpty, !request.deviceId.isEmpty else {
                throw StreamProtocolError.malformedChunk("unsupported device request")
            }
            if let existing = state.deviceRequests[request.invocationId], existing != request {
                throw StreamProtocolError.invalidSequence("device request changed")
            }
            state.deviceRequests[request.invocationId] = request
        case "error": state.errors.append(try requiredString(chunk, "errorText"))
        case "abort": state.aborted = true
        case "finish":
            guard state.openText.isEmpty || state.aborted else { throw StreamProtocolError.invalidSequence("finish with open text block") }
            state.finished = true
        default:
            // Optional data extensions can be ignored by older clients. An
            // unknown core chunk may change ordering or completion semantics.
            guard type.hasPrefix("data-") else {
                throw StreamProtocolError.malformedChunk("unsupported core chunk: \(type)")
            }
        }
        return state
    }

    public func validateEOF() throws {
        guard state.finished, state.done else { throw StreamProtocolError.incompleteStream }
    }

    private func requiredString(_ value: JSONValue, _ key: String, allowEmpty: Bool = false) throws -> String {
        guard let string = value[key]?.string, allowEmpty || !string.isEmpty else {
            throw StreamProtocolError.malformedChunk("missing or invalid \(key)")
        }
        return string
    }
}
