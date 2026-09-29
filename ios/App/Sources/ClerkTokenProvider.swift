import Foundation
import ClerkKit
import InstantClient

/// The one application token cache. Clerk owns sign-in/Keychain persistence;
/// request code only uses this store, including refresh after a server rejection.
/// Main-actor isolation makes cache replacement and refresh coalescing atomic.
@MainActor
final class ClerkTokenStore {
    struct Identity: Equatable, Sendable {
        let userID: String
        let sessionID: String
    }
    struct Credential: Sendable {
        let jwt: String
        let identity: Identity
        let expiresAt: Date

        init(jwt: String) throws {
            struct Claims: Decodable { let sub: String; let sid: String; let exp: Double }
            let parts = jwt.split(separator: ".", omittingEmptySubsequences: false)
            guard parts.count == 3 else { throw ClerkTokenError.invalidToken }
            var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
            guard let data = Data(base64Encoded: payload), let claims = try? JSONDecoder().decode(Claims.self, from: data),
                  claims.exp.isFinite, !claims.sub.isEmpty, !claims.sid.isEmpty else { throw ClerkTokenError.invalidToken }
            self.jwt = jwt
            identity = Identity(userID: claims.sub, sessionID: claims.sid)
            expiresAt = Date(timeIntervalSince1970: claims.exp)
        }
    }

    static let shared = ClerkTokenStore(currentIdentity: clerkIdentity, now: { Date() },
                                       log: { ListeningDiagnostics.shared.record($0, $1) }, fetch: fetchClerkCredential)

    private static func clerkIdentity() -> Identity? {
        guard ClerkConfig.isConfigured, let session = Clerk.shared.session, let user = Clerk.shared.user else { return nil }
        return Identity(userID: user.id, sessionID: session.id)
    }

    private static func fetchClerkCredential(_ identity: Identity) async throws -> Credential {
        guard ClerkConfig.isConfigured, let session = Clerk.shared.session, session.id == identity.sessionID,
              Clerk.shared.user?.id == identity.userID else { throw ClerkTokenError.notSignedIn }
        // This store owns the cache; never let the SDK return a rejected JWT.
        let options = Session.GetTokenOptions(template: nil, expirationBuffer: 30, skipCache: true)
        guard let jwt = try await session.getToken(options) else { throw ClerkTokenError.noToken }
        return try Credential(jwt: jwt)
    }

    private let currentIdentity: @MainActor () -> Identity?
    private let fetch: @MainActor (Identity) async throws -> Credential
    private let now: @MainActor () -> Date
    private let log: @MainActor (String, [String: String]) -> Void
    private var identity: Identity?
    private var cached: Credential?
    private struct Refresh {
        let id: UUID
        let task: Task<Credential, Error>
    }
    private var refresh: Refresh?
    private let refreshBuffer: TimeInterval = 30

    init(currentIdentity: @escaping @MainActor () -> Identity?,
         now: @escaping @MainActor () -> Date,
         log: @escaping @MainActor (String, [String: String]) -> Void,
         fetch: @escaping @MainActor (Identity) async throws -> Credential) {
        self.currentIdentity = currentIdentity; self.now = now; self.log = log; self.fetch = fetch
    }

    /// Providers capture this scope. A request begun by account A can never be
    /// refreshed as account B, or as a different login session for account A.
    func activeIdentity() -> Identity? {
        let active = currentIdentity()
        if active != identity {
            refresh?.task.cancel(); refresh = nil; cached = nil; identity = active
        }
        return active
    }

    func token(for expected: Identity?, rejectedToken: String? = nil) async throws -> String {
        try Task.checkCancellation()
        let active = activeIdentity()
        guard let expected, expected == active else { throw ClerkTokenError.notSignedIn }
        if let cached, cached.jwt != rejectedToken, cached.expiresAt.timeIntervalSince(now()) > refreshBuffer {
            return cached.jwt
        }
        if rejectedToken != nil { log("auth.token_rejected", ["reason":"http_401"]) }
        cached = nil
        let pending: Refresh
        if let refresh { pending = refresh }
        else {
            log("auth.refresh_started", ["reason": rejectedToken == nil ? "missing_or_expiring" : "http_401"])
            let fetch = self.fetch
            pending = Refresh(id: UUID(), task: Task { try await fetch(expected) })
            refresh = pending
        }
        do {
            let value = try await pending.task.value
            guard activeIdentity() == expected, value.identity == expected else { throw ClerkTokenError.notSignedIn }
            // A late waiter cannot reinstall a credential invalidated by a newer
            // refresh (or by signing out and back in while fetch was suspended).
            if refresh?.id != pending.id, cached?.jwt != value.jwt {
                return try await token(for: expected)
            }
            // Slow refreshes/offline responses must never install an expired JWT.
            guard value.expiresAt.timeIntervalSince(now()) > 10 else { throw ClerkTokenError.expiredToken }
            if refresh?.id == pending.id {
                cached = value; refresh = nil
                log("auth.refresh_succeeded", ["seconds":String(Int(value.expiresAt.timeIntervalSince(now())))])
            }
            try Task.checkCancellation()
            return value.jwt
        } catch {
            if refresh?.id == pending.id {
                refresh = nil
                log("auth.refresh_failed", ["reason": error is CancellationError ? "cancelled" : "refresh_unavailable"])
            }
            throw error
        }
    }
}

/// A scope-bound handle to the shared store, never an independent token cache.
struct ClerkTokenProvider: InstantTokenProvider {
    private let store: ClerkTokenStore
    private let identity: ClerkTokenStore.Identity?
    @MainActor init(store: ClerkTokenStore = .shared, userID: String? = nil) {
        self.store = store
        let active = store.activeIdentity()
        identity = userID == nil || active?.userID == userID ? active : nil
    }
    func token() async throws -> String { try await store.token(for: identity) }
    func refreshToken(rejectedToken: String) async throws -> String {
        try await store.token(for: identity, rejectedToken: rejectedToken)
    }
}

enum ClerkTokenError: Error {
    case notSignedIn
    case noToken
    case invalidToken
    case expiredToken
}

/// Pending recordings share the token store but remain bound to their owner.
struct ListeningTokenProvider: InstantTokenProvider {
    private let provider: ClerkTokenProvider
    @MainActor init(userID: String) { provider = ClerkTokenProvider(userID: userID) }
    func token() async throws -> String { try await provider.token() }
    func refreshToken(rejectedToken: String) async throws -> String {
        try await provider.refreshToken(rejectedToken: rejectedToken)
    }
}
