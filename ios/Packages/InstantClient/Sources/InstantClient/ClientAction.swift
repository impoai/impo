import Foundation

/// A server-prepared action. Receiving or replaying it never performs a native operation.
public struct ClientAction: Codable, Equatable, Sendable, Identifiable {
    public static let capabilities = ["impo_open_link", "impo_navigate"]
    public let id: String
    public let capability: String
    public let parameters: JSONValue

    public init?(toolName: String, output: JSONValue?) {
        guard Self.capabilities.contains(toolName), let output,
              output["kind"]?.string == "client_action", output["schemaVersion"] == .number(1),
              output["capability"]?.string == toolName, output["execution"]?.string == "device",
              output["interaction"]?.string == "tap", output["status"]?.string == "ready",
              let id = output["actionId"]?.string, UUID(uuidString: id) != nil,
              let parameters = output["parameters"] else { return nil }
        self.id = id; self.capability = toolName; self.parameters = parameters
        guard targetURL != nil else { return nil }
    }

    public static func from(part: JSONValue) -> ClientAction? {
        guard part["type"]?.string == "dynamic-tool", part["state"]?.string == "output-available",
              let name = part["toolName"]?.string else { return nil }
        return ClientAction(toolName: name, output: part["output"])
    }

    /// Native adapters construct destinations from typed arguments; the model cannot select a URL scheme.
    public var targetURL: URL? {
        guard case .object(let values) = parameters else { return nil }
        if capability == "impo_open_link" {
            guard Set(values.keys) == ["url"], let raw = parameters["url"]?.string,
                  !raw.isEmpty, raw.utf16.count <= 4096, !raw.contains("\\"),
                  raw.rangeOfCharacter(from: .whitespacesAndNewlines.union(.controlCharacters)) == nil,
                  let url = URLComponents(string: raw), url.scheme?.lowercased() == "https",
                  let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { return nil }
            return url.url
        }
        guard capability == "impo_navigate", Set(values.keys) == ["destination", "mode"],
              let destination = parameters["destination"]?.string,
              !destination.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, destination.utf16.count <= 300,
              destination.rangeOfCharacter(from: .controlCharacters) == nil,
              let mode = parameters["mode"]?.string,
              let flag = ["driving": "d", "walking": "w", "transit": "r"][mode] else { return nil }
        var url = URLComponents(string: "https://maps.apple.com/")!
        url.queryItems = [URLQueryItem(name: "daddr", value: destination), URLQueryItem(name: "dirflg", value: flag)]
        return url.url
    }

    public var isVideo: Bool {
        guard capability == "impo_open_link", let host = targetURL?.host?.lowercased() else { return false }
        return host == "youtu.be" || host == "youtube.com" || host.hasSuffix(".youtube.com")
    }
    public var title: String { capability == "impo_navigate" ? "Get directions" : isVideo ? "Open video" : "Open link" }
    public var detail: String { capability == "impo_navigate" ? parameters["destination"]?.string ?? "" : targetURL?.host ?? "" }
}
