import Foundation
import UIKit
import InstantClient

/// System-owned file transfers survive suspension. The file and metadata remain
/// until a verified server receipt. Refresh delayed requests through the shared
/// token store, with one immediate auth retry if the server still rejects one.
final class ListeningBackgroundUpload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let shared = ListeningBackgroundUpload()
    static let identifier = "ai.impo.listening.upload"
    private let sessionIdentifier: String
    private let authorizeRequest: @MainActor @Sendable (URLRequest) async throws -> URLRequest
    init(identifier: String = ListeningBackgroundUpload.identifier,
         authorizeRequest: @escaping @MainActor @Sendable (URLRequest) async throws -> URLRequest = {
             try await ListeningBackgroundUpload.authorizeDelayedRequest($0)
         }) {
        sessionIdentifier = identifier; self.authorizeRequest = authorizeRequest
        super.init()
    }
    private struct Description: Codable { let directory: String; let id: String; var batch: StoredListeningBatch? = nil }
    private let lock = NSLock()
    private var waiting: [Int: CheckedContinuation<Void, Error>] = [:]
    private var finished: [Int: Result<Void, Error>] = [:]
    private var bodies: [Int: Data] = [:]
    private var completion: (@MainActor @Sendable () -> Void)?
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: sessionIdentifier)
        configuration.sessionSendsLaunchEvents = true
        // Batching is already decided before scheduling. Avoid deliberately
        // delaying a short-lived user token until it expires.
        configuration.isDiscretionary = false
        configuration.timeoutIntervalForResource = 3_600
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        return URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    }()

    @MainActor func reconnect(completion: (@MainActor @Sendable () -> Void)? = nil) {
        if let completion { lock.withLock { self.completion = completion } }
        _ = session
    }

    @MainActor func upload(request: URLRequest, item: PendingRecording, store: ListeningStore) async throws {
        let description = Description(directory: store.directory.path, id: item.id)
        try await schedule(request: request, description: description, file: store.audioURL(item.id))
    }

    @MainActor func uploadBatch(client: InstantClient, request: URLRequest, batch: StoredListeningBatch, store: ListeningStore) async throws {
        try await uploadBatch(client: client, request: request,
                              description: Description(directory: store.directory.path, id: batch.batchId, batch: batch),
                              file: ListeningBatchStore(store: store).payloadURL(batch.batchId))
    }

    @MainActor private func uploadBatch(client: InstantClient, request: URLRequest, description: Description, file: URL) async throws {
        try await client.retryingAuthorization(for: request) { request in
            try await self.schedule(request: request, description: description, file: file)
        }
    }

    @MainActor private func schedule(request: URLRequest, description: Description, file: URL) async throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let encoded = String(data: try encoder.encode(description), encoding: .utf8)!
        // A relaunched app must reconnect to an existing task, not race a second
        // upload/delete of the same local file.
        let existing = await session.allTasks.first { $0.taskDescription == encoded && $0.state != .completed && $0.state != .canceling }
        if existing == nil && !FileManager.default.fileExists(atPath: file.path) { return }
        try await withCheckedThrowingContinuation { continuation in
            let task = existing ?? session.uploadTask(with: request, fromFile: file)
            // Opt into willBeginDelayedRequest: iOS can defer even a
            // non-discretionary task beyond a Clerk token's lifetime.
            if existing == nil,
               let header = request.value(forHTTPHeaderField: "Authorization"), header.hasPrefix("Bearer "),
               (try? ClerkTokenStore.Credential(jwt: String(header.dropFirst(7)))) != nil {
                task.earliestBeginDate = Date()
            }
            task.taskDescription = encoded
            let completed: Result<Void, Error>? = lock.withLock {
                if let result = finished.removeValue(forKey: task.taskIdentifier) { return result }
                waiting[task.taskIdentifier] = continuation
                return nil
            }
            if let completed { continuation.resume(with: completed) }
            else { task.resume() }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willBeginDelayedRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLSession.DelayedRequestDisposition, URLRequest?) -> Void) {
        Task { @MainActor in
            do {
                let fresh = try await authorizeRequest(request)
                ListeningDiagnostics.shared.record("upload.authorization_updated", ["reason":"delayed_start"])
                completionHandler(.useNewRequest, fresh)
            } catch {
                // Keep the file on disk if Clerk cannot refresh or the account
                // changed. Never send this recording with another user's token.
                ListeningDiagnostics.shared.error("upload.authorization_deferred", error)
                completionHandler(.cancel, nil)
            }
        }
    }

    @MainActor static func authorizeDelayedRequest(_ request: URLRequest, store: ClerkTokenStore = .shared) async throws -> URLRequest {
        guard let header = request.value(forHTTPHeaderField: "Authorization"), header.hasPrefix("Bearer ") else { throw ClerkTokenError.noToken }
        let old = try ClerkTokenStore.Credential(jwt: String(header.dropFirst(7)))
        var fresh = request
        fresh.setValue("Bearer \(try await store.token(for: old.identity))", forHTTPHeaderField: "Authorization")
        return fresh
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.withLock {
            bodies[dataTask.taskIdentifier, default: Data()].append(data)
            if (bodies[dataTask.taskIdentifier]?.count ?? 0) > 1_048_576 { dataTask.cancel() }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        let body = lock.withLock { bodies.removeValue(forKey: task.taskIdentifier) ?? Data() }
        let result: Result<Void, Error>
        do {
            if let error { throw error }
            guard let text = task.taskDescription, let data = text.data(using: .utf8),
                  let descriptor = try? JSONDecoder().decode(Description.self, from: data),
                  UUID(uuidString: descriptor.id) != nil else { throw InstantClientError.invalidResponse }
            let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false).appendingPathComponent("Listening").standardizedFileURL
            let directory = URL(fileURLWithPath: descriptor.directory).standardizedFileURL
            guard directory.deletingLastPathComponent().path == root.path else { throw InstantClientError.invalidResponse }
            let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 202 {
                if let batch = descriptor.batch {
                    let receipt = try JSONDecoder().decode(ListeningBatchReceipt.self, from: body)
                    try ListeningBatchStore(store: ListeningStore(existingDirectory: directory)).verify(receipt, for: batch)
                } else {
                    let receipt = try JSONDecoder().decode(ListeningSegment.self, from: body)
                    guard receipt.clientSegmentId == descriptor.id else { throw InstantClientError.invalidResponse }
                }
            } else if status == 401 { throw InstantAuthorizationError(request: task.currentRequest ?? task.originalRequest) }
            else if status != 410 { throw InstantClientError.unexpectedHTTPStatus(status) }
            let store = ListeningStore(existingDirectory: directory)
            if let batch = descriptor.batch { try ListeningBatchStore(store: store).removeConfirmed(batch) }
            else { try store.remove(descriptor.id) }
            ListeningDiagnostics.shared.record("upload.receipt", ["batchId":descriptor.id,"status":String(status),"requestId":(task.response as? HTTPURLResponse)?.value(forHTTPHeaderField:"X-Request-Id") ?? "unknown"])
            result = .success(())
        } catch {
            let descriptor = task.taskDescription.flatMap { $0.data(using:.utf8) }.flatMap { try? JSONDecoder().decode(Description.self,from:$0) }
            ListeningDiagnostics.shared.error("upload.failed",error,["batchId":descriptor?.id ?? "unknown","status":String((task.response as? HTTPURLResponse)?.statusCode ?? 0),"requestId":(task.response as? HTTPURLResponse)?.value(forHTTPHeaderField:"X-Request-Id") ?? "unknown"])
            result = .failure(error)
        }
        let continuation = lock.withLock {
            let value = waiting.removeValue(forKey: task.taskIdentifier)
            if value == nil {
                if finished.count >= 128 { finished.removeAll() }
                finished[task.taskIdentifier] = result
            }
            return value
        }
        continuation?.resume(with: result)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let finished = lock.withLock { let value = completion; completion = nil; return value }
        Task { @MainActor in finished?() }
    }
}

final class ListeningAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        guard identifier == ListeningBackgroundUpload.identifier else { completionHandler(); return }
        // UIKit delivers this on main; hop back there after URLSession's delegate
        // has persisted all receipts.
        let completion = BackgroundCompletion(completionHandler)
        ListeningBackgroundUpload.shared.reconnect { completion.call() }
    }
}

private final class BackgroundCompletion: @unchecked Sendable {
    let completion: () -> Void
    init(_ completion: @escaping () -> Void) { self.completion = completion }
    @MainActor func call() { completion() }
}
