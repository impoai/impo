import Foundation

public struct AccountDeletionChallenge: Codable, Sendable {
    public let challengeId: String
    public let token: String
    public let expiresAt: String
    public let appleAuthorizationAvailable: Bool?
}
public struct AccountDeletionReceipt: Codable, Sendable {
    public let requestId: String
    public let status: String
    public let requestedAt: String
    public let receiptToken: String?
    public let appleManualRevocationRequired: Bool?
}
public extension InstantClient {
    func prepareAccountDeletion() async throws -> AccountDeletionChallenge {
        try await send("POST", ["account", "deletion-challenge"], body: .object([:]))
    }
    func deleteAccount(challenge: AccountDeletionChallenge, confirmation: String, appleAuthorizationCode: String? = nil) async throws -> AccountDeletionReceipt {
        var body: [String: JSONValue] = [
            "challengeId": .string(challenge.challengeId), "token": .string(challenge.token), "confirmation": .string(confirmation),
        ]
        if let appleAuthorizationCode { body["appleAuthorizationCode"] = .string(appleAuthorizationCode) }
        return try await send("DELETE", ["account"], body: .object(body))
    }
    /// This client must carry the deletion receipt token, which survives logout.
    func accountDeletionStatus(_ requestId: String) async throws -> AccountDeletionReceipt {
        try await send("GET", ["account", "deletions", requestId])
    }
}
