import Foundation

public enum ConnectionStatus: String, Codable, Sendable {
    case disconnected, pending, connected, expired
}

/// Connection status is verified by Instant's server, never inferred from OAuth UI dismissal.
public struct ConnectorStatus: Decodable, Equatable, Sendable {
    public let status: ConnectionStatus
    public let email: String?
    public let expiresAt: String?

    public init(status: ConnectionStatus, email: String? = nil, expiresAt: String? = nil) {
        self.status = status
        self.email = email
        self.expiresAt = expiresAt
    }
}

/// One app on the server's connector shelf, with this user's connection state.
public struct ConnectorSummary: Decodable, Equatable, Identifiable, Sendable {
    public let toolkit: String
    public let name: String
    public let description: String?
    public let logoURL: String?
    public let featured: Bool
    public let status: ConnectionStatus
    public let email: String?
    public let expiresAt: String?
    public var id: String { toolkit }

    public var connection: ConnectorStatus { ConnectorStatus(status: status, email: email, expiresAt: expiresAt) }

    public func with(_ connection: ConnectorStatus) -> ConnectorSummary {
        ConnectorSummary(toolkit: toolkit, name: name, description: description, logoURL: logoURL, featured: featured, status: connection.status, email: connection.email, expiresAt: connection.expiresAt)
    }

    public init(toolkit: String, name: String, description: String? = nil, logoURL: String? = nil, featured: Bool = false, status: ConnectionStatus, email: String? = nil, expiresAt: String? = nil) {
        self.toolkit = toolkit
        self.name = name
        self.description = description
        self.logoURL = logoURL
        self.featured = featured
        self.status = status
        self.email = email
        self.expiresAt = expiresAt
    }
}

public struct ConnectorList: Decodable, Equatable, Sendable {
    public let connectors: [ConnectorSummary]
}

public struct ConnectorConnectResponse: Decodable, Equatable, Sendable {
    public let redirectURL: String
    public let expiresAt: String
}
