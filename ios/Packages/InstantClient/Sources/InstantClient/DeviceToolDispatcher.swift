import Foundation

/// A process-local execution receipt prevents reconnect/replay from executing a
/// tool twice. A shipping app must persist this ledger before side effects.
public actor DeviceToolDispatcher {
    public typealias Handler = @Sendable (String, JSONValue) async throws -> JSONValue
    private struct Outcome: Sendable {
        let executionId: String
        let output: JSONValue?
        let error: String?
    }
    private let client: InstantClient
    private let deviceId: String
    private let supportedTools: Set<String>
    private var outcomes: [String: Outcome] = [:]
    private var completed: Set<String> = []
    private var inFlight: Set<String> = []

    public init(client: InstantClient, deviceId: String, supportedTools: Set<String> = ["instant_test_echo"]) {
        self.client = client
        self.deviceId = deviceId
        self.supportedTools = supportedTools
    }

    /// Standard tool display chunks never suffice to authorize local execution.
    /// A matching device request and successful server claim are both required.
    public func dispatchAvailable(in state: UIMessageState, handler: Handler) async throws -> [ToolResultReceipt] {
        var receipts: [ToolResultReceipt] = []
        for request in state.deviceRequests.values.sorted(by: { $0.invocationId < $1.invocationId }) {
            guard request.deviceId == deviceId,
                  let tool = state.tools[request.toolCallId], tool.output == nil, tool.error == nil else { continue }
            if let receipt = try await execute(id: request.invocationId, name: tool.name, input: tool.input, handler: handler) {
                receipts.append(receipt)
            }
        }
        return receipts
    }

    /// Fetch unfinished work after reconnect when there is no live SSE request.
    public func dispatchPending(handler: Handler) async throws -> [ToolResultReceipt] {
        var receipts: [ToolResultReceipt] = []
        for invocation in try await client.pendingInvocations(deviceId: deviceId) {
            guard invocation.deviceId == deviceId else { continue }
            if let receipt = try await execute(id: invocation.invocationId, name: invocation.toolName, input: invocation.input, handler: handler) {
                receipts.append(receipt)
            }
        }
        return receipts
    }

    private func execute(id: String, name: String, input: JSONValue, handler: Handler) async throws -> ToolResultReceipt? {
        guard supportedTools.contains(name), !completed.contains(id), !inFlight.contains(id) else { return nil }
        inFlight.insert(id)
        defer { inFlight.remove(id) }
        // Claim before new local work. A stored outcome retries only its result:
        // the server can accept an identical receipt even after completion.
        if outcomes[id] == nil {
            let claim: ToolClaim
            do {
                claim = try await client.claimInvocation(id, deviceId: deviceId)
            } catch let error as InstantAPIError where error.statusCode == 410 && error.code == "invocation_expired" {
                // A reconstruction can contain a historical request before its
                // terminal tool output. It must remain safe to render after an
                // app restart, even when this dispatcher's ledger is empty.
                completed.insert(id)
                return nil
            }
            let outcome: Outcome
            do {
                outcome = Outcome(executionId: claim.executionId, output: try await handler(name, input), error: nil)
            } catch {
                let message = (error as? any LocalizedError)?.errorDescription ?? String(describing: error)
                outcome = Outcome(executionId: claim.executionId, output: nil, error: message)
            }
            outcomes[id] = outcome
        }
        guard let outcome = outcomes[id] else { return nil }
        let receipt = try await client.submitResult(id, deviceId: deviceId, executionId: outcome.executionId,
                                                   success: outcome.error == nil, output: outcome.output, error: outcome.error)
        completed.insert(id)
        return receipt
    }
}
