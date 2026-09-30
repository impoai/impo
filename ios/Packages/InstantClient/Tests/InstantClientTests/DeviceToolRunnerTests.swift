import Foundation
import XCTest
@testable import InstantClient

final class DeviceToolRunnerTests: XCTestCase {
    func testInterruptedNativeWriteIsNotRepeatedAfterRestart() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("receipts.json")
        let transport = try DeviceTransportFixture(mode: .normal, toolName: "impo_create_reminder")
        let executions = ExecutionCounter()
        let runner = try DeviceToolRunner(transport: transport, deviceID: "device-a", receiptFile: file, nonRepeatableTools: ["impo_create_reminder"])
        do {
            try await runner.poll { _ in
                _ = await executions.run()
                throw CancellationError() // The native write succeeded, but its result was never saved.
            }
            XCTFail("Expected interruption")
        } catch is CancellationError {}
        let restarted = try DeviceToolRunner(transport: transport, deviceID: "device-a", receiptFile: file, nonRepeatableTools: ["impo_create_reminder"])
        _ = try await restarted.poll { _ in await executions.run() }
        let count = await executions.count, results = await transport.results
        XCTAssertEqual(count, 1, "An uncertain reminder must never be created twice")
        XCTAssertEqual(results, [DeviceToolExecutionResult(success: false, error: "device_write_outcome_unknown")])
    }

    func testInterruptedReadIsRetriedInsteadOfSavingCancellationAsFinalResult() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("receipts.json")
        let transport = try DeviceTransportFixture(mode: .normal)
        let runner = try DeviceToolRunner(transport: transport, deviceID: "device-a", receiptFile: file)
        do {
            try await runner.poll { _ in throw CancellationError() }
            XCTFail("Expected cancellation")
        } catch is CancellationError {}
        let restarted = try DeviceToolRunner(transport: transport, deviceID: "device-a", receiptFile: file)
        _ = try await restarted.poll { _ in DeviceToolExecutionResult(success: true, output: .object(["resumed": .bool(true)])) }
        let results = await transport.results
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].output?["resumed"], .bool(true))
    }

    func testDisconnectBlocksSavedResultUpload() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("receipts.json")
        let transport = try DeviceTransportFixture()
        let executions = ExecutionCounter()
        let runner = try DeviceToolRunner(transport: transport, deviceID: "device-a", receiptFile: file)
        do { _ = try await runner.poll { _ in await executions.run() } } catch is URLError {}
        let restarted = try DeviceToolRunner(transport: transport, deviceID: "device-a", receiptFile: file)
        let completed = try await restarted.poll(isEnabled: { _ in false }) { _ in await executions.run() }
        let results = await transport.results
        let count = await executions.count
        XCTAssertEqual(completed, 0)
        XCTAssertEqual(results.count, 1, "Disconnect must block a saved result's second POST")
        XCTAssertEqual(count, 1)
    }

    func testSavedResultSurvivesLostAcknowledgementAndRunnerRestart() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("receipts.json")
        let transport = try DeviceTransportFixture()
        let executions = ExecutionCounter()
        let first = try DeviceToolRunner(transport: transport, deviceID: "device-a", receiptFile: file)
        do {
            try await first.poll { _ in await executions.run() }
            XCTFail("The first result acknowledgement is deliberately lost")
        } catch is URLError {}
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))

        let restarted = try DeviceToolRunner(transport: transport, deviceID: "device-a", receiptFile: file)
        let completed = try await restarted.poll { _ in await executions.run() }
        let count = await executions.count
        let submitted = await transport.results
        XCTAssertEqual(completed, 1)
        XCTAssertEqual(count, 1, "Never re-read device data after a lost result acknowledgement")
        XCTAssertEqual(submitted.count, 2)
        XCTAssertEqual(submitted[0], submitted[1])
        XCTAssertEqual(try Data(contentsOf: file), Data("{}".utf8))
    }

    func testWrongDeviceAndExpiredDispatchNeverExecute() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let transport = try DeviceTransportFixture(mode: .stale)
        let executions = ExecutionCounter()
        let runner = try DeviceToolRunner(transport: transport, deviceID: "device-a", receiptFile: directory.appendingPathComponent("receipts.json"))
        let completed = try await runner.poll { _ in await executions.run() }
        let count = await executions.count
        let claims = await transport.claims
        XCTAssertEqual(completed, 0)
        XCTAssertEqual(count, 0)
        XCTAssertEqual(claims, 0)
    }

    func testCancellationAfterNativeReadStillSavesReceipt() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("receipts.json")
        let transport = try DeviceTransportFixture(mode: .normal)
        let executions = ExecutionCounter()
        let runner = try DeviceToolRunner(transport: transport, deviceID: "device-a", receiptFile: file)
        let task = Task {
            try await runner.poll { _ in
                let value = await executions.run()
                withUnsafeCurrentTask { $0?.cancel() }
                return value
            }
        }
        do { _ = try await task.value; XCTFail("Expected cancellation") } catch is CancellationError {}
        let restarted = try DeviceToolRunner(transport: transport, deviceID: "device-a", receiptFile: file)
        _ = try await restarted.poll { _ in await executions.run() }
        let count = await executions.count
        XCTAssertEqual(count, 1)
    }

    func testCorruptReceiptDoesNotSilentlyReexecute() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("receipts.json")
        try Data("broken".utf8).write(to: file)
        let transport = try DeviceTransportFixture()
        XCTAssertThrowsError(try DeviceToolRunner(transport: transport, deviceID: "device-a", receiptFile: file))
    }
}

private actor ExecutionCounter {
    private(set) var count = 0
    func run() -> DeviceToolExecutionResult {
        count += 1
        return DeviceToolExecutionResult(success: true, output: .object(["count": .number(Double(count))]))
    }
}

private actor DeviceTransportFixture: DeviceToolTransport {
    enum Mode { case lostAcknowledgement, stale, normal }
    private let mode: Mode
    private let invocation: PendingInvocation
    private(set) var claims = 0
    private(set) var results: [DeviceToolExecutionResult] = []
    init(mode: Mode = .lostAcknowledgement, toolName: String = "ios_list_calendar_events") throws {
        self.mode = mode
        let deadline = ISO8601DateFormatter().string(from: Date().addingTimeInterval(mode == .stale ? -60 : 600))
        invocation = try JSONDecoder().decode(PendingInvocation.self, from: JSONEncoder().encode(JSONValue.object([
            "invocationId": .string("call-a"), "toolCallId": .string("provider-call-a"),
            "deviceId": .string(mode == .stale ? "wrong-device" : "device-a"),
            "expiresAt": .string(deadline), "toolName": .string(toolName), "input": .object([:]),
        ])))
    }
    func pendingInvocations(deviceId: String) async throws -> [PendingInvocation] { [invocation] }
    func claimInvocation(_ id: String, deviceId: String) async throws -> ToolClaim {
        claims += 1
        return ToolClaim(executionId: "execution-a", expiresAt: invocation.expiresAt)
    }
    func submitResult(_ id: String, deviceId: String, executionId: String, success: Bool, output: JSONValue?, error: String?) async throws -> ToolResultReceipt {
        results.append(DeviceToolExecutionResult(success: success, output: output, error: error))
        if mode == .lostAcknowledgement && results.count == 1 { throw URLError(.networkConnectionLost) }
        return ToolResultReceipt(accepted: true, duplicate: results.count > 1)
    }
}
