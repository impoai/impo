import Foundation
import XCTest
@testable import InstantClient

private actor InvocationCounter {
    var count = 0
    func increment() { count += 1 }
}

@MainActor
final class IntegrationTests: XCTestCase {
    private func client(token: String = "instant-test-alice") throws -> InstantClient {
        guard let origin = ProcessInfo.processInfo.environment["INSTANT_TEST_BASE_URL"], let url = URL(string: origin) else {
            throw XCTSkip("Set INSTANT_TEST_BASE_URL to run real Swift ↔ TypeScript HTTP tests")
        }
        return InstantClient(baseURL: url, bearerToken: token)
    }

    private func device(_ client: InstantClient) async throws -> String {
        try await client.registerDevice(installationId: UUID().uuidString).deviceId
    }

    private func message(_ client: InstantClient, scenario: String = "text", deviceId: String? = nil) async throws -> MessageReceipt {
        try await client.sendMessage(clientMessageId: UUID().uuidString, text: "Swift 协议测试 👋", scenario: scenario, deviceId: deviceId)
    }

    private func collect(_ client: InstantClient, id: String) async throws -> UIMessageState {
        var final = UIMessageState()
        for try await state in client.stream(submissionId: id) { final = state }
        XCTAssertTrue(final.done)
        return final
    }

    private func waitFor(_ client: InstantClient, id: String, condition: (Submission) -> Bool) async throws -> Submission {
        let deadline = ContinuousClock.now + .seconds(3)
        while ContinuousClock.now < deadline {
            let snapshot = try await client.submission(id)
            if condition(snapshot) { return snapshot }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Submission did not reach expected state")
        return try await client.submission(id)
    }

    private func invocation(_ client: InstantClient, deviceId: String) async throws -> PendingInvocation {
        let deadline = ContinuousClock.now + .seconds(3)
        while ContinuousClock.now < deadline {
            if let first = try await client.pendingInvocations(deviceId: deviceId).first { return first }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw NSError(domain: "IntegrationTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Expected pending invocation"])
    }

    private func expectAPIError(_ status: Int, _ code: String, operation: () async throws -> Void) async throws {
        do {
            try await operation()
            XCTFail("Expected HTTP \(status) \(code)")
        } catch let error as InstantAPIError {
            XCTAssertEqual(error.statusCode, status)
            XCTAssertEqual(error.code, code)
            XCTAssertNotNil(error.requestId)
            XCTAssertFalse(error.retryable)
        }
    }

    func testTextAndReplayUseStableMessageIdentity() async throws {
        let client = try client()
        let receipt = try await message(client)
        let first = try await collect(client, id: receipt.submissionId)
        XCTAssertEqual(first.text, "你好，Instant 👋")
        XCTAssertEqual(first.status, "completed")
        XCTAssertNotEqual(first.messageId, receipt.messageId, "POST returns user message ID; stream uses assistant ID")
        let second = try await collect(client, id: receipt.submissionId)
        XCTAssertEqual(second, first, "Reconnection reconstructs, rather than duplicating, the message")
        let snapshot = try await client.submission(receipt.submissionId)
        XCTAssertEqual(snapshot.messageId, first.messageId)
    }

    func testToolRoundTripDispatchesOnlyOnceAcrossReplay() async throws {
        let client = try client()
        let deviceId = try await device(client)
        let dispatcher = DeviceToolDispatcher(client: client, deviceId: deviceId)
        let counter = InvocationCounter()
        let receipt = try await message(client, scenario: "tool", deviceId: deviceId)
        var final = UIMessageState()
        var sawWaitingDevice = false
        let handler: DeviceToolDispatcher.Handler = { name, input in
            await counter.increment()
            XCTAssertEqual(name, "instant_test_echo")
            return .object(["echo": input["text"] ?? .null])
        }
        for try await state in client.stream(submissionId: receipt.submissionId) {
            sawWaitingDevice = sawWaitingDevice || state.status == "waiting_device"
            _ = try await dispatcher.dispatchAvailable(in: state, handler: handler)
            final = state
        }
        XCTAssertTrue(sawWaitingDevice)
        XCTAssertEqual(final.text, "工具完成：来自 Swift 的回声 👋")
        XCTAssertEqual(final.status, "completed")
        XCTAssertTrue(final.done)
        for try await state in client.stream(submissionId: receipt.submissionId) {
            _ = try await dispatcher.dispatchAvailable(in: state, handler: handler)
        }
        let freshDispatcher = DeviceToolDispatcher(client: client, deviceId: deviceId)
        for try await state in client.stream(submissionId: receipt.submissionId) {
            _ = try await freshDispatcher.dispatchAvailable(in: state, handler: handler)
        }
        let count = await counter.count
        XCTAssertEqual(count, 1)
        let snapshot = try await client.submission(receipt.submissionId)
        XCTAssertEqual(snapshot.resultCount, 1)
    }

    func testToolFailureIsAnAcceptedResultButFailedSubmission() async throws {
        struct ToolFailure: LocalizedError { var errorDescription: String? { "permission_denied" } }
        let client = try client()
        let deviceId = try await device(client)
        let receipt = try await message(client, scenario: "tool", deviceId: deviceId)
        let dispatcher = DeviceToolDispatcher(client: client, deviceId: deviceId)
        var accepted = false
        var final = UIMessageState()
        for try await state in client.stream(submissionId: receipt.submissionId) {
            let results = try await dispatcher.dispatchAvailable(in: state) { _, _ in throw ToolFailure() }
            accepted = accepted || results.contains(where: \.accepted)
            final = state
        }
        XCTAssertTrue(accepted)
        XCTAssertEqual(final.status, "failed")
        XCTAssertEqual(final.text, "工具失败：permission_denied")
        XCTAssertEqual(final.tools.values.first?.error, "permission_denied")
        XCTAssertTrue(final.done)
    }

    func testClaimsResultsIdempotencyAndOwnership() async throws {
        let alice = try client()
        let bob = try client(token: "instant-test-bob")
        let aliceDevice = try await device(alice)
        let otherDevice = try await device(alice)
        let receipt = try await message(alice, scenario: "tool", deviceId: aliceDevice)
        let request = try await invocation(alice, deviceId: aliceDevice)
        try await expectAPIError(404, "not_found") { _ = try await bob.submission(receipt.submissionId) }
        try await expectAPIError(404, "not_found") { _ = try await bob.claimInvocation(request.invocationId, deviceId: aliceDevice) }
        try await expectAPIError(403, "wrong_device") { _ = try await alice.claimInvocation(request.invocationId, deviceId: otherDevice) }
        try await expectAPIError(409, "not_claimed") {
            _ = try await alice.submitResult(request.invocationId, deviceId: aliceDevice, executionId: "unclaimed", success: true, output: .object(["echo": .string("different")]))
        }
        let claim = try await alice.claimInvocation(request.invocationId, deviceId: aliceDevice)
        let repeatedClaim = try await alice.claimInvocation(request.invocationId, deviceId: aliceDevice)
        XCTAssertEqual(claim, repeatedClaim)
        try await expectAPIError(409, "execution_mismatch") {
            _ = try await alice.submitResult(request.invocationId, deviceId: aliceDevice, executionId: "wrong-execution", success: true, output: .object(["echo": .string("different")]))
        }
        let output: JSONValue = .object(["echo": request.input["text"] ?? .null])
        let first = try await alice.submitResult(request.invocationId, deviceId: aliceDevice, executionId: claim.executionId, success: true, output: output)
        let retry = try await alice.submitResult(request.invocationId, deviceId: aliceDevice, executionId: claim.executionId, success: true, output: output)
        XCTAssertTrue(first.accepted)
        XCTAssertFalse(first.duplicate)
        XCTAssertTrue(retry.duplicate)
        try await expectAPIError(409, "result_conflict") {
            _ = try await alice.submitResult(request.invocationId, deviceId: aliceDevice, executionId: claim.executionId, success: true, output: .object(["echo": .string("different")]))
        }
        try await expectAPIError(404, "not_found") {
            _ = try await bob.submitResult(request.invocationId, deviceId: aliceDevice, executionId: claim.executionId, success: true, output: output)
        }
        try await expectAPIError(403, "wrong_device") {
            _ = try await alice.submitResult(request.invocationId, deviceId: otherDevice, executionId: claim.executionId, success: true, output: output)
        }
        let snapshot = try await alice.submission(receipt.submissionId)
        XCTAssertEqual(snapshot.resultCount, 1)
        XCTAssertEqual(snapshot.status, "completed")
    }

    func testMessageAndRegistrationIdempotencyAndAuthentication() async throws {
        let client = try client()
        let installationId = UUID().uuidString
        let firstDevice = try await client.registerDevice(installationId: installationId)
        let secondDevice = try await client.registerDevice(installationId: installationId)
        XCTAssertEqual(firstDevice.deviceId, secondDevice.deviceId)
        let messageId = UUID().uuidString
        let first = try await client.sendMessage(clientMessageId: messageId, text: "你好")
        let second = try await client.sendMessage(clientMessageId: messageId, text: "你好")
        XCTAssertEqual(first, second)
        try await expectAPIError(409, "idempotency_conflict") {
            _ = try await client.sendMessage(clientMessageId: messageId, text: "different")
        }
        let anonymous = try self.client(token: "invalid")
        try await expectAPIError(401, "unauthorized") { _ = try await anonymous.submission(first.submissionId) }
        try await expectAPIError(401, "unauthorized") { _ = try await self.collect(anonymous, id: first.submissionId) }
    }

    func testTimeoutRejectsLateResultAndRecoveryFindsPendingWork() async throws {
        let client = try client()
        let deviceId = try await device(client)
        let receipt = try await message(client, scenario: "tool_timeout", deviceId: deviceId)
        let request = try await invocation(client, deviceId: deviceId)
        let claim = try await client.claimInvocation(request.invocationId, deviceId: deviceId)
        let final = try await collect(client, id: receipt.submissionId)
        XCTAssertEqual(final.status, "failed")
        XCTAssertEqual(final.tools.values.first?.error, "device_timeout")
        try await expectAPIError(410, "invocation_expired") {
            _ = try await client.submitResult(request.invocationId, deviceId: deviceId, executionId: claim.executionId, success: true, output: .object(["echo": .string("different")]))
        }

        let recovered = try await message(client, scenario: "tool", deviceId: deviceId)
        _ = try await invocation(client, deviceId: deviceId)
        let dispatcher = DeviceToolDispatcher(client: client, deviceId: deviceId)
        let results = try await dispatcher.dispatchPending { _, input in .object(["echo": input["text"] ?? .null]) }
        XCTAssertEqual(results.count, 1, "Device can find work without relying on a live SSE delivery")
        let recoveredFinal = try await collect(client, id: recovered.submissionId)
        XCTAssertEqual(recoveredFinal.status, "completed")
    }

    func testDisconnectClosesSubscriptionWithoutCancellingExecution() async throws {
        let client = try client()
        let receipt = try await message(client, scenario: "slow_text")
        let subscriber = Task {
            for try await _ in client.stream(submissionId: receipt.submissionId) {
                try await Task.sleep(for: .seconds(10))
            }
        }
        _ = try await waitFor(client, id: receipt.submissionId) { $0.subscriberCount > 0 }
        subscriber.cancel()
        _ = await subscriber.result
        let final = try await waitFor(client, id: receipt.submissionId) { $0.status == "completed" && $0.subscriberCount == 0 }
        XCTAssertEqual(final.status, "completed")
        let restored = try await collect(client, id: receipt.submissionId)
        XCTAssertEqual(restored.text, "你好，Instant 👋")
        XCTAssertFalse(restored.aborted)
    }

    func testExplicitCancelTerminatesStreamAndInvalidatesDeviceRequest() async throws {
        let client = try client()
        let deviceId = try await device(client)
        let receipt = try await message(client, scenario: "tool", deviceId: deviceId)
        let request = try await invocation(client, deviceId: deviceId)
        let claim = try await client.claimInvocation(request.invocationId, deviceId: deviceId)
        let cancelled = try await client.cancelSubmission(receipt.submissionId)
        XCTAssertEqual(cancelled.status, "cancelled")
        let repeatCancel = try await client.cancelSubmission(receipt.submissionId)
        XCTAssertEqual(repeatCancel.status, "cancelled")
        let final = try await collect(client, id: receipt.submissionId)
        XCTAssertTrue(final.aborted)
        XCTAssertTrue(final.done)
        XCTAssertEqual(final.status, "cancelled")
        try await expectAPIError(410, "invocation_expired") {
            _ = try await client.submitResult(request.invocationId, deviceId: deviceId, executionId: claim.executionId, success: true, output: .object(["echo": .string("different")]))
        }
    }

    func testTruncatedStreamCannotBecomeSuccessfulCompletion() async throws {
        let client = try client()
        let receipt = try await message(client, scenario: "broken_stream")
        var sawDone = false
        do {
            for try await state in client.stream(submissionId: receipt.submissionId) { sawDone = sawDone || state.done }
            XCTFail("A truncated stream must throw")
        } catch {
            XCTAssertEqual(error as? StreamProtocolError, .incompleteStream)
        }
        XCTAssertFalse(sawDone)
    }
}
