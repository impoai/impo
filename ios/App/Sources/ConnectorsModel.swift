import Foundation
import Observation
import InstantClient

struct ConnectorAuthorization: Identifiable {
    let id = UUID()
    let toolkit: String
    let url: URL
}

/// The server's connector shelf and this user's connections. OAuth credentials stay on the
/// server; the browser URL is kept only in memory. One operation runs at a time.
@MainActor @Observable
final class ConnectorsModel {
    private(set) var connectors: [ConnectorSummary] = []
    private(set) var loaded = false
    private(set) var isBusy = false
    private(set) var busyToolkit: String?
    private(set) var error: String?
    private(set) var errorToolkit: String?
    var authorization: ConnectorAuthorization?
    private(set) var awaitingToolkit: String?
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

    func connector(_ toolkit: String) -> ConnectorSummary? { connectors.first { $0.toolkit == toolkit } }

    /// Connected or in-progress apps first, then the curated shelf.
    var active: [ConnectorSummary] { connectors.filter { $0.status != .disconnected || awaitingToolkit == $0.toolkit } }
    var suggested: [ConnectorSummary] { connectors.filter { $0.featured && $0.status == .disconnected && awaitingToolkit != $0.toolkit } }

    func search(_ query: String) -> [ConnectorSummary] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return connectors.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending } }
        return connectors
            .filter { $0.name.localizedCaseInsensitiveContains(text) || $0.toolkit.localizedCaseInsensitiveContains(text) || ($0.description?.localizedCaseInsensitiveContains(text) ?? false) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func statusText(_ toolkit: String) -> String {
        guard isAvailable else { return "Enable Live chat to connect apps." }
        let connection = connector(toolkit)
        if awaitingToolkit == toolkit && connection?.status != .connected { return "Waiting for authorization" }
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
        connectors = []
        loaded = false
        authorization = nil
        awaitingToolkit = nil
        clearError()
    }

    func resume() {
        foreground = true
        if task == nil { reload() }
    }

    func pause() {
        foreground = false
        stop()
    }

    /// Load the shelf with this user's statuses. Never starts OAuth.
    func reload() {
        guard let context, foreground else { return }
        let token = begin(nil)
        task = Task { [self] in
            defer { finish(token) }
            do {
                let list = try await client(context).connectors()
                try check(context, token)
                connectors = list
                loaded = true
            } catch {
                if current(context, token) { fail(nil, "Couldn't load apps. Check your server connection and try again.") }
            }
        }
    }

    func connect(_ toolkit: String) {
        guard let context, foreground, !isBusy else { return }
        let token = begin(toolkit)
        task = Task { [self] in
            defer { finish(token) }
            do {
                let response = try await client(context).connectConnector(toolkit)
                try check(context, token)
                guard let parts = URLComponents(string: response.redirectURL),
                      parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty,
                      parts.user == nil, parts.password == nil, let url = parts.url else {
                    throw URLError(.badURL)
                }
                awaitingToolkit = toolkit
                authorization = ConnectorAuthorization(toolkit: toolkit, url: url)
            } catch {
                if current(context, token) { fail(toolkit, "Couldn't open \(name(toolkit)) authorization. Try again.") }
            }
        }
    }

    /// Check immediately, then poll for at most one minute in the foreground.
    /// Closing Safari never means the account is connected.
    func refreshStatus(_ toolkit: String, checkAuthorization: Bool = false) {
        guard let context, foreground else { return }
        let token = begin(toolkit)
        task = Task { [self] in
            defer { finish(token) }
            do {
                let deadline = Date().addingTimeInterval(60)
                let api = client(context)
                var result = try await (checkAuthorization ? api.refreshConnector(toolkit) : api.connectorStatus(toolkit))
                try check(context, token)
                apply(toolkit, result)
                while result.status == .pending && Date() < deadline {
                    isBusy = false
                    try await Task.sleep(for: .seconds(3))
                    try check(context, token)
                    guard Date() < deadline else { break }
                    isBusy = true
                    result = try await api.refreshConnector(toolkit)
                    try check(context, token)
                    apply(toolkit, result)
                }
            } catch {
                if current(context, token) { fail(toolkit, "Couldn't verify \(name(toolkit)). Check your server connection and tap Refresh.") }
            }
        }
    }

    func disconnect(_ toolkit: String) {
        guard let context, foreground, !isBusy else { return }
        let token = begin(toolkit)
        task = Task { [self] in
            defer { finish(token) }
            do {
                let result = try await client(context).disconnectConnector(toolkit)
                try check(context, token)
                apply(toolkit, result)
            } catch {
                if current(context, token) { fail(toolkit, "Couldn't disconnect \(name(toolkit)). Tap Refresh to check its status before trying again.") }
            }
        }
    }

    private func name(_ toolkit: String) -> String { connector(toolkit)?.name ?? toolkit }

    private func apply(_ toolkit: String, _ value: ConnectorStatus) {
        if let index = connectors.firstIndex(where: { $0.toolkit == toolkit }) {
            connectors[index] = connectors[index].with(value)
        }
        if value.status == .pending { awaitingToolkit = toolkit } else if awaitingToolkit == toolkit { awaitingToolkit = nil }
        if value.status != .pending, authorization?.toolkit == toolkit { authorization = nil }
    }

    private func fail(_ toolkit: String?, _ message: String) {
        error = message
        errorToolkit = toolkit
    }

    private func clearError() {
        error = nil
        errorToolkit = nil
    }

    private func begin(_ toolkit: String?) -> UUID {
        stop()
        isBusy = true
        busyToolkit = toolkit
        clearError()
        return operation
    }

    private func stop() {
        operation = UUID()
        task?.cancel()
        task = nil
        isBusy = false
        busyToolkit = nil
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
        busyToolkit = nil
        task = nil
    }
}
