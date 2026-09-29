import Foundation

public enum GmailConnectionStatus: String, Codable, Sendable {
    case disconnected, pending, connected, expired
}

/// Connection status is verified by Instant's server, never inferred from OAuth UI dismissal.
public struct GmailConnectorStatus: Decodable, Equatable, Sendable {
    public let status: GmailConnectionStatus
    public let email: String?
    public let expiresAt: String?
}

public struct GmailConnectResponse: Decodable, Equatable, Sendable {
    public let redirectURL: String
    public let expiresAt: String
}
