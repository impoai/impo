import Foundation

public struct DeviceToolExecutionResult: Codable, Equatable, Sendable {
    public let success: Bool
    public let output: JSONValue?
    public let error: String?

    public init(success: Bool, output: JSONValue? = nil, error: String? = nil) {
        self.success = success
        self.output = output
        self.error = error
    }
}

public protocol DeviceToolTransport: Sendable {
    func pendingInvocations(deviceId: String) async throws -> [PendingInvocation]
    func claimInvocation(_ id: String, deviceId: String) async throws -> ToolClaim
    func submitResult(_ id: String, deviceId: String, executionId: String, success: Bool, output: JSONValue?, error: String?) async throws -> ToolResultReceipt
}

extension InstantClient: DeviceToolTransport {}

/// Poll the authenticated command API, never execute tools from replayed UI events.
/// Receipts survive a lost HTTP acknowledgement and app restart. Keep a separate
/// file for every server/user/device scope. Non-repeatable tools persist uncertainty
/// before executing, so a crash cannot silently duplicate a native write.
public actor DeviceToolRunner {
    private struct Receipt: Codable {
        let executionID: String
        let expiresAt: String
        let result: DeviceToolExecutionResult
    }

    private let transport: any DeviceToolTransport
    private let deviceID: String
    private let receiptFile: URL
    private let nonRepeatableTools: Set<String>
    private var receipts: [String: Receipt]
    private var polling = false

    public init(transport: any DeviceToolTransport, deviceID: String, receiptFile: URL, nonRepeatableTools: Set<String> = []) throws {
        self.transport = transport
        self.deviceID = deviceID
        self.receiptFile = receiptFile
        self.nonRepeatableTools = nonRepeatableTools
        if FileManager.default.fileExists(atPath: receiptFile.path) {
            // A corrupt store must not silently re-execute previously completed work.
            receipts = try JSONDecoder().decode([String: Receipt].self, from: Data(contentsOf: receiptFile))
        } else { receipts = [:] }
    }

    /// One foreground pass. Multiple callers cannot execute the same pending call.
    @discardableResult
    public func poll(isEnabled: @Sendable (PendingInvocation) async -> Bool = { _ in true },
                     execute: @Sendable (PendingInvocation) async throws -> DeviceToolExecutionResult) async throws -> Int {
        guard !polling else { return 0 }
        polling = true
        defer { polling = false }
        try Task.checkCancellation()
        receipts = receipts.filter { Self.date($0.value.expiresAt).map { $0 > Date() } ?? false }
        try save()
        let pending = try await transport.pendingInvocations(deviceId: deviceID)
        var completed = 0
        for invocation in pending {
            try Task.checkCancellation()
            guard invocation.deviceId == deviceID,
                  let deadline = Self.date(invocation.expiresAt), deadline > Date() else { continue }
            guard await isEnabled(invocation) else { continue }
            do {
                let claim = try await transport.claimInvocation(invocation.invocationId, deviceId: deviceID)
                try Task.checkCancellation()
                guard let claimDeadline = Self.date(claim.expiresAt), claimDeadline > Date() else { continue }
                let receipt: Receipt
                if let saved = receipts[invocation.invocationId] {
                    // Never reuse a result for a different execution fence.
                    guard saved.executionID == claim.executionId else { throw InstantClientError.invalidResponse }
                    receipt = saved
                } else {
                    if nonRepeatableTools.contains(invocation.toolName) {
                        receipts[invocation.invocationId] = Receipt(executionID: claim.executionId, expiresAt: claim.expiresAt,
                            result: DeviceToolExecutionResult(success: false, error: "device_write_outcome_unknown"))
                        try save()
                    }
                    let result = try await execute(invocation)
                    receipt = Receipt(executionID: claim.executionId, expiresAt: claim.expiresAt, result: result)
                    receipts[invocation.invocationId] = receipt
                    // Persist before checking cancellation or starting the result POST.
                    try save()
                }
                try Task.checkCancellation()
                // Revocation must also gate cached-result uploads, not just native reads.
                guard await isEnabled(invocation) else { continue }
                let acknowledgement = try await transport.submitResult(invocation.invocationId, deviceId: deviceID,
                    executionId: receipt.executionID, success: receipt.result.success,
                    output: receipt.result.output, error: receipt.result.error)
                guard acknowledgement.accepted else { throw InstantClientError.invalidResponse }
                receipts.removeValue(forKey: invocation.invocationId)
                try save()
                completed += 1
            } catch let error as InstantAPIError where error.statusCode == 404 || error.statusCode == 410 {
                // Expired/cancelled requests are not executable on a later foreground.
                receipts.removeValue(forKey: invocation.invocationId)
                try save()
            }
        }
        return completed
    }

    private func save() throws {
        let directory = receiptFile.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(receipts).write(to: receiptFile, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: receiptFile.path)
        var file = receiptFile
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try file.setResourceValues(values)
    }

    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}
