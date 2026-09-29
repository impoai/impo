import Foundation
import Network
import XCTest
import InstantClient
@testable import Instant

@MainActor
final class ClerkTokenStoreTests: XCTestCase {
    private let alice = ClerkTokenStore.Identity(userID: "alice", sessionID: "session-a")
    private let bob = ClerkTokenStore.Identity(userID: "bob", sessionID: "session-b")

    func testFeaturesShareCacheAndRefreshBeforeExpiry() async throws {
        let fixture = TokenFixture(identity: alice)
        let store = fixture.store()
        let chat = ClerkTokenProvider(store: store)
        let echo = ClerkTokenProvider(store: store, userID: alice.userID)
        let first = try await chat.token()
        let same = try await echo.token()
        XCTAssertEqual(first, same)
        XCTAssertEqual(fixture.fetches, 1)
        fixture.now += 31
        let fresh = try await echo.token()
        XCTAssertNotEqual(first, fresh)
        XCTAssertEqual(fixture.fetches, 2)
        let chatFresh = try await chat.token()
        XCTAssertEqual(fresh, chatFresh)
    }

    func testConcurrentFeaturesAnd401sShareOneRefresh() async throws {
        let fixture = TokenFixture(identity: alice)
        let store = fixture.store()
        let provider = ClerkTokenProvider(store: store)
        let old = try await provider.token()
        fixture.block = true
        let callers = (0..<20).map { _ in Task { try await provider.refreshToken(rejectedToken: old) } }
        await fixture.waitUntilBlocked()
        for _ in 0..<30 { await Task.yield() }
        XCTAssertEqual(fixture.fetches, 2)
        fixture.release()
        var tokens: [String] = []
        for caller in callers { tokens.append(try await caller.value) }
        XCTAssertEqual(Set(tokens).count, 1)
        XCTAssertNotEqual(tokens.first, old)
        let late401 = try await provider.refreshToken(rejectedToken: old)
        XCTAssertEqual(late401, tokens.first)
        XCTAssertEqual(fixture.fetches, 2, "A late 401 must reuse the already refreshed credential")
    }

    func testLogoutDuringRefreshCannotReturnCredentialAndNewAccountIsIsolated() async throws {
        let fixture = TokenFixture(identity: alice)
        let store = fixture.store()
        let oldProvider = ClerkTokenProvider(store: store)
        fixture.block = true
        let pending = Task { try await oldProvider.token() }
        await fixture.waitUntilBlocked()
        fixture.identity = nil
        XCTAssertNil(store.activeIdentity())
        fixture.identity = bob
        let newProvider = ClerkTokenProvider(store: store)
        fixture.release()
        do { _ = try await pending.value; XCTFail("Old account refresh must be discarded") } catch {}
        do { _ = try await oldProvider.token(); XCTFail("Old client cannot adopt Bob's identity") } catch {}
        let current = try ClerkTokenStore.Credential(jwt: await newProvider.token())
        XCTAssertEqual(current.identity, bob)
    }

    func testSameUserNewSessionInvalidatesOldProvider() async throws {
        let fixture = TokenFixture(identity: alice)
        let store = fixture.store()
        let old = ClerkTokenProvider(store: store)
        _ = try await old.token()
        fixture.identity = .init(userID: alice.userID, sessionID: "replacement-session")
        do { _ = try await old.token(); XCTFail("Old session must not be silently replaced") } catch {}
        let current = ClerkTokenProvider(store: store)
        let token = try ClerkTokenStore.Credential(jwt: await current.token())
        XCTAssertEqual(token.identity, fixture.identity)
    }

    func testFailedRefreshCanRecoverWithoutCachingError() async throws {
        let fixture = TokenFixture(identity: alice)
        fixture.fail = true
        let provider = ClerkTokenProvider(store: fixture.store())
        do { _ = try await provider.token(); XCTFail("Expected offline failure") } catch {}
        fixture.fail = false
        _ = try await provider.token()
        XCTAssertEqual(fixture.fetches, 2)
    }

    func testCancelledWaiterDoesNotCancelSharedRefresh() async throws {
        let fixture = TokenFixture(identity: alice)
        let provider = ClerkTokenProvider(store: fixture.store())
        fixture.block = true
        let cancelled = Task { try await provider.token() }
        await fixture.waitUntilBlocked()
        let survivor = Task { try await provider.token() }
        for _ in 0..<10 { await Task.yield() }
        cancelled.cancel()
        fixture.release()
        do { _ = try await cancelled.value; XCTFail("Cancelled caller must not send a request") } catch is CancellationError {} catch { XCTFail("Unexpected cancellation error") }
        _ = try await survivor.value
        XCTAssertEqual(fixture.fetches, 1)
    }

    func testExpiredAndWrongAccountCredentialsAreNeverReturned() async throws {
        let fixture = TokenFixture(identity: alice)
        fixture.lifetime = -1
        let provider = ClerkTokenProvider(store: fixture.store())
        do { _ = try await provider.token(); XCTFail("Expired credential must be rejected") } catch {}
        fixture.lifetime = 60
        fixture.returnIdentity = bob
        do { _ = try await provider.token(); XCTFail("Wrong account must be rejected") } catch {}
        fixture.returnIdentity = nil
        _ = try await provider.token()
    }

    func testDelayedUploadAfterNineMinutesUsesCurrentTokenAndPreservesPayload() async throws {
        let fixture = TokenFixture(identity: alice)
        let store = fixture.store()
        let provider = ClerkTokenProvider(store: store)
        let old = try await provider.token()
        var request = URLRequest(url: URL(string: "https://test.invalid/api/v1/listening/batches")!)
        request.httpMethod = "POST"
        request.httpBody = Data("same immutable batch".utf8)
        request.allowsCellularAccess = false
        request.setValue("Bearer \(old)", forHTTPHeaderField: "Authorization")
        fixture.now += 548
        let fresh = try await ListeningBackgroundUpload.authorizeDelayedRequest(request, store: store)
        XCTAssertNotEqual(fresh.value(forHTTPHeaderField: "Authorization"), request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(fresh.url, request.url)
        XCTAssertEqual(fresh.httpBody, request.httpBody)
        XCTAssertEqual(fresh.httpMethod, "POST")
        XCTAssertFalse(fresh.allowsCellularAccess)
        fixture.identity = bob
        do { _ = try await ListeningBackgroundUpload.authorizeDelayedRequest(request, store: store); XCTFail("Cannot reauthorize another user's queued audio") } catch {}
    }

    func testSystemBackgroundTransferRefreshesDelayedTokenAndRetriesActualRejectedToken() async throws {
        let server = try AuthUploadServer()
        let url = try await server.start()
        defer { server.stop() }
        let fixture = TokenFixture(identity: alice)
        let tokenStore = fixture.store()
        let client = InstantClient(baseURL: url, tokenProvider: ClerkTokenProvider(store: tokenStore))
        let request = try await client.listeningBatchUploadRequest()
        fixture.now += 548
        let store = try ListeningStore(scope: "auth-background-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: store.directory) }
        let item = PendingRecording(id: UUID().uuidString.lowercased(), startedAt: Date().addingTimeInterval(-3), endedAt: Date(), hasSpeech: true, ready: true)
        try store.save(item)
        try Data("unchanged audio".utf8).write(to: store.audioURL(item.id))
        let batches = ListeningBatchStore(store: store)
        let batch = try XCTUnwrap(batches.seal(force: true).first)
        var callbacks = 0
        let transfer = ListeningBackgroundUpload(identifier: "ai.impo.auth-test." + UUID().uuidString) { request in
            callbacks += 1
            return try await ListeningBackgroundUpload.authorizeDelayedRequest(request, store: tokenStore)
        }
        let task = Task { try await transfer.uploadBatch(client: client, request: request, batch: batch, store: store) }
        try await listeningDeadline(task, seconds: 30)
        XCTAssertGreaterThanOrEqual(callbacks, 2, "Real URLSession must invoke the delayed-request delegate on both attempts")
        XCTAssertEqual(fixture.fetches, 3, "Initial JWT, delayed-start replacement, then refresh of the actual rejected JWT")
        XCTAssertEqual(server.tokenSerials, [2, 3])
        XCTAssertEqual(server.payloads.count, 2)
        XCTAssertEqual(server.payloads.first, server.payloads.last)
        XCTAssertTrue(try store.recordings().isEmpty)
        XCTAssertTrue(try batches.batches().isEmpty)
    }

    func testDiagnosticsContainNoTokensOrAccountIdentifiers() async throws {
        let fixture = TokenFixture(identity: alice)
        let provider = ClerkTokenProvider(store: fixture.store())
        let old = try await provider.token()
        let new = try await provider.refreshToken(rejectedToken: old)
        let logs = fixture.logs.joined(separator: "\n")
        XCTAssertTrue(logs.contains("auth.refresh_succeeded"))
        for secret in [old, new, alice.userID, alice.sessionID] { XCTAssertFalse(logs.contains(secret)) }
    }
}

@MainActor
private final class TokenFixture {
    var identity: ClerkTokenStore.Identity?
    var returnIdentity: ClerkTokenStore.Identity?
    var now: TimeInterval = 1_800_000_000
    var fetches = 0
    var lifetime: TimeInterval = 60
    var block = false
    var fail = false
    var logs: [String] = []
    private var gate: CheckedContinuation<Void, Never>?
    init(identity: ClerkTokenStore.Identity) { self.identity = identity }
    func store() -> ClerkTokenStore {
        ClerkTokenStore(currentIdentity: { self.identity }, now: { Date(timeIntervalSince1970: self.now) },
                        log: { self.logs.append($0 + " " + $1.description) }, fetch: { identity in
            self.fetches += 1
            let serial = self.fetches
            if self.block { await withCheckedContinuation { self.gate = $0 } }
            if self.fail { throw URLError(.notConnectedToInternet) }
            let owner = self.returnIdentity ?? identity
            let data = try JSONSerialization.data(withJSONObject: ["sub":owner.userID, "sid":owner.sessionID, "exp":self.now + self.lifetime, "serial":serial])
            let payload = data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            return try ClerkTokenStore.Credential(jwt: "header.\(payload).signature")
        })
    }
    func waitUntilBlocked() async {
        for _ in 0..<1000 {
            if gate != nil { return }
            await Task.yield()
        }
        XCTFail("Refresh did not reach test gate")
    }
    func release() { block = false; let pending = gate; gate = nil; pending?.resume() }
}

/// Local HTTP peer for an actual system-owned file transfer (URLProtocol cannot
/// intercept background sessions). Deliberately rejects the first credential.
private final class AuthUploadServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "auth-upload-test")
    private let lock = NSLock()
    private var serials: [Int] = []
    private var bodies: [Data] = []
    var tokenSerials: [Int] { lock.withLock { serials } }
    var payloads: [Data] { lock.withLock { bodies } }
    init() throws { listener = try NWListener(using: .tcp, on: .any) }
    func start() async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { [self] state in
                switch state {
                case .ready:
                    listener.stateUpdateHandler = nil
                    continuation.resume(returning: URL(string: "http://127.0.0.1:\(listener.port!.rawValue)")!)
                case .failed(let error):
                    listener.stateUpdateHandler = nil
                    continuation.resume(throwing: error)
                default: break
                }
            }
            listener.newConnectionHandler = { [self] connection in
                connection.start(queue: queue)
                read(connection, Data())
            }
            listener.start(queue: queue)
        }
    }
    func stop() { listener.cancel() }
    private func read(_ connection: NWConnection, _ previous: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [self] chunk, _, complete, error in
            var data = previous
            if let chunk { data.append(chunk) }
            guard data.count < 2_000_000 else { connection.cancel(); return }
            if let split = data.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: data[..<split.lowerBound], as: UTF8.self)
                let fields = head.components(separatedBy: "\r\n").dropFirst().reduce(into: [String:String]()) { result, line in
                    let parts = line.split(separator: ":", maxSplits: 1)
                    if parts.count == 2 { result[parts[0].lowercased()] = parts[1].trimmingCharacters(in: .whitespaces) }
                }
                let length = Int(fields["content-length"] ?? "0") ?? 0
                if data.count - split.upperBound >= length {
                    let body = Data(data[split.upperBound..<split.upperBound + length])
                    respond(connection, fields: fields, body: body)
                    return
                }
            }
            if complete || error != nil { connection.cancel(); return }
            read(connection, data)
        }
    }
    private func respond(_ connection: NWConnection, fields: [String:String], body: Data) {
        let token = String((fields["authorization"] ?? "").dropFirst(7))
        let parts = token.split(separator: ".")
        var payload = parts.count == 3 ? String(parts[1]) : ""
        payload = payload.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        let claims = Data(base64Encoded: payload).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String:Any] }
        let ordinal = lock.withLock { serials.append(claims?["serial"] as? Int ?? -1); bodies.append(body); return bodies.count }
        let input = (try? JSONSerialization.jsonObject(with: body)) as? [String:Any] ?? [:]
        let response: [String:Any] = ordinal == 1 ? ["error":["code":"unauthorized","message":"Fixture rejection","retryable":false]] : ["batchId":input["batchId"] ?? "missing","streamId":input["streamId"] ?? "missing","sequence":input["sequence"] ?? 0,"status":"accepted"]
        let json = try! JSONSerialization.data(withJSONObject: response)
        var wire = Data("HTTP/1.1 \(ordinal == 1 ? "401 Unauthorized" : "202 Accepted")\r\nContent-Type: application/json\r\nContent-Length: \(json.count)\r\nConnection: close\r\n\r\n".utf8)
        wire.append(json)
        connection.send(content: wire, completion: .contentProcessed { _ in connection.cancel() })
    }
}
