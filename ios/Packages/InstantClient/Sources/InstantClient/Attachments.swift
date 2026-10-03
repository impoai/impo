import Foundation

public struct UploadedAttachment: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let mediaType: String
    public let sizeBytes: Int
    public let status: String
    public var deliveredFile: DeliveredFile { DeliveredFile(fileId: "upload_" + id, name: name, mediaType: mediaType, sizeBytes: sizeBytes) }
}

public struct AttachmentUploadTicket: Decodable, Sendable {
    public let status: String
    public let url: URL?
    public let headers: [String: String]?
    public let file: UploadedAttachment?
}
