import Foundation
import Observation
import InstantClient

struct GmailAuthorization: Identifiable {
    let id = UUID()
    let url: URL
}

/// OAuth credentials stay on the server. The browser URL is kept only in memory.
@MainActor @Observable
final class GmailConnectionModel {
    private(set) var connection: GmailConnectorStatus?
    private(set) var isBusy = false
    private(set) var error: String?
    var authorization: GmailAuthorization?
    private(set) var awaitingAuthorization = false
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var operation = UUID()
    @ObservationIgnored private var foreground = true
    @ObservationIgnored private var context: Context?
    @ObservationIgnored private let session: URLSession

    // identityTag exists only for the change-detection in configure(); the
    // token provider itself isn't Equatable (it may fetch a fresh token per call).
    private struct Context: Equatable {
        let endpoint: URL
        let identityTag: String
        let tokenProvider: any InstantTokenProvider
        static func == (lhs: Context, rhs: Context) -> Bool { lhs.endpoint == rhs.endpoint && lhs.identityTag == rhs.identityTag }
    }

    init(session: URLSession = .shared) { self.session = session }

    private func client(_ context: Context) -> InstantClient {
        InstantClient(baseURL: context.endpoint, tokenProvider: context.tokenProvider, session: session)
    }

    var isAvailable: Bool { context != nil }

    var statusText: String {
        guard isAvailable else { return "Enable Live chat to connect Gmail." }
        if awaitingAuthorization && connection?.status != .connected { return "Waiting for authorization" }
        switch connection?.status {
        case .connected: return connection?.email ?? "Connected"
        case .pending: return "Waiting for authorization"
        case .expired: return "Connection expired · connect again"
        case .disconnected: return "Not connected"
        case nil: return isBusy ? "Checking connection…" : "Connection not checked"
        }
    }

    func configure(endpoint: URL?, identityTag: String, tokenProvider: any InstantTokenProvider) {
        let next = endpoint.map { Context(endpoint: $0, identityTag: identityTag, tokenProvider: tokenProvider) }
        guard next != context else { return }
        stop()
        context = next
        connection = nil
        authorization = nil
        awaitingAuthorization = false
        error = nil
    }

    func resume() {
        foreground = true
        if task == nil { refreshStatus() }
    }

    func pause() {
        foreground = false
        stop()
    }

    func connect() {
        guard let context, foreground, !isBusy else { return }
        let token = begin()
        task = Task { [self] in
            defer { finish(token) }
            do {
                let response = try await client(context).connectGmail()
                try check(context, token)
                guard let parts = URLComponents(string: response.redirectURL),
                      parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty,
                      parts.user == nil, parts.password == nil, let url = parts.url else {
                    throw URLError(.badURL)
                }
                awaitingAuthorization = true
                authorization = GmailAuthorization(url: url)
            } catch {
                if current(context, token) { self.error = "Couldn't open Gmail authorization. Try again." }
            }
        }
    }

    /// Check immediately, then initiate polls for at most one minute in the
    /// foreground. Closing Safari never means the account is connected.
    func refreshStatus(checkAuthorization: Bool = false) {
        guard let context, foreground else { return }
        let token = begin()
        task = Task { [self] in
            defer { finish(token) }
            do {
                let deadline = Date().addingTimeInterval(60)
                let api = client(context)
                var result = try await (checkAuthorization ? api.refreshGmail() : api.gmailStatus())
                try check(context, token)
                apply(result)
                while result.status == .pending && Date() < deadline {
                    isBusy = false
                    try await Task.sleep(for: .seconds(3))
                    try check(context, token)
                    guard Date() < deadline else { break }
                    isBusy = true
                    result = try await api.refreshGmail()
                    try check(context, token)
                    apply(result)
                }
            } catch {
                if current(context, token) { self.error = "Couldn't verify Gmail. Check your server connection and tap Refresh." }
            }
        }
    }

    func disconnect() {
        guard let context, foreground, !isBusy else { return }
        let token = begin()
        task = Task { [self] in
            defer { finish(token) }
            do {
                let result = try await client(context).disconnectGmail()
                try check(context, token)
                apply(result)
            } catch {
                if current(context, token) { self.error = "Couldn't disconnect Gmail. Tap Refresh to check its status before trying again." }
            }
        }
    }

    private func apply(_ value: GmailConnectorStatus) {
        connection = value
        awaitingAuthorization = value.status == .pending
        if value.status != .pending { authorization = nil }
    }

    private func begin() -> UUID {
        stop()
        isBusy = true
        error = nil
        return operation
    }

    private func stop() {
        operation = UUID()
        task?.cancel()
        task = nil
        isBusy = false
    }

    private func current(_ context: Context, _ token: UUID) -> Bool {
        !Task.isCancelled && foreground && operation == token && self.context == context
    }

    private func check(_ context: Context, _ token: UUID) throws {
        guard current(context, token) else { throw CancellationError() }
    }

    private func finish(_ token: UUID) {
        guard operation == token else { return }
        isBusy = false
        task = nil
    }
}
