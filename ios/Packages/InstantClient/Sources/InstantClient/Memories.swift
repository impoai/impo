import Foundation

/// A long-term memory written by the hourly consolidation pipeline. Categories are Mem0's
/// default list; they stay strings so a newer server category never breaks decoding.
public struct Memory: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let content: String
    public let categories: [String]
    /// `chat:<id>` or `echo:<id>` evidence references.
    public let sourceIds: [String]
    public let createdAt: String
    public let updatedAt: String
    public let expiresAt: String?
}
public struct MemoryPage: Codable, Sendable { public let memories: [Memory]; public let nextCursor: String? }
public struct MemorySummary: Codable, Equatable, Sendable {
    public let total: Int
    /// Count per category; a memory with several categories counts in each.
    public let categories: [String: Int]
}
