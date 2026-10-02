import Foundation

/// Account-level app profile. `onboarded` lets a returning account skip onboarding on any device.
public struct AccountProfile: Decodable, Equatable, Sendable {
    public let mode: String?
    public let onboarded: Bool
    public let displayName: String?
    public let assistantName: String?
    public let avatarIndex: Int?

    public init(onboarded: Bool, displayName: String? = nil, assistantName: String? = nil, avatarIndex: Int? = nil, mode: String? = nil) {
        self.mode = mode
        self.onboarded = onboarded
        self.displayName = displayName
        self.assistantName = assistantName
        self.avatarIndex = avatarIndex
    }
}
