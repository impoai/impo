import Foundation

/// The OS audio service may stall during setup. Racing a continuation (rather
/// than a task group, which waits for uncooperative children) keeps the UI usable.
func listeningDeadline<Value: Sendable>(_ task: Task<Value, Error>, seconds: Double = 10) async throws -> Value {
    try await withCheckedThrowingContinuation { continuation in
        let completion = ListeningCompletion(continuation)
        Task {
            let result = await task.result
            completion.resolve(result)
        }
        Task {
            try? await Task.sleep(for: .seconds(seconds))
            if completion.resolve(.failure(URLError(.timedOut))) { task.cancel() }
        }
    }
}

private final class ListeningCompletion<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?
    init(_ continuation: CheckedContinuation<Value, Error>) { self.continuation = continuation }
    @discardableResult func resolve(_ result: Result<Value, Error>) -> Bool {
        lock.lock()
        let pending = continuation; continuation = nil
        lock.unlock()
        pending?.resume(with: result)
        return pending != nil
    }
}
