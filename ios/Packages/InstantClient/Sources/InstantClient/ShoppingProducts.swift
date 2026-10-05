import Foundation

/// An owned reference to a catalog call. Prices and images are fetched afresh when displayed.
public struct ProductSelection: Codable, Equatable, Sendable, Identifiable {
    public let selectionId: String
    public let productIds: [String]
    public let query: String?
    public var id: String { selectionId }

    public static func from(part: JSONValue) -> ProductSelection? {
        guard part["type"]?.string == "data-impo-products" else { return nil }
        return ProductSelection(part["data"])
    }

    init?(_ data: JSONValue?) {
        guard let data, data["schemaVersion"] == .number(1), let id = data["selectionId"]?.string,
              !id.isEmpty, id.count <= 200, case .array(let ids)? = data["productIds"], !ids.isEmpty, ids.count <= 8 else { return nil }
        let strings = ids.compactMap(\.string)
        guard strings.count == ids.count, strings.allSatisfy({ $0.hasPrefix("gid://shopify/") && $0.count <= 200 }) else { return nil }
        selectionId = id; productIds = strings; query = data["query"]?.string
    }
}

public struct ShoppingProduct: Decodable, Equatable, Sendable, Identifiable {
    public struct Price: Decodable, Equatable, Sendable {
        public let amount: Int
        public let currency: String
        public let formatted: String
    }
    public struct Option: Decodable, Equatable, Sendable {
        public let name: String
        public let values: [String]
    }
    public let id: String
    public let title: String
    public let merchant: String
    public let url: String
    public let imageURL: String?
    public let description: String?
    public let price: Price?
    public let available: Bool?
    public let options: [Option]

    public var merchantURL: URL? { Self.https(url) }
    public var image: URL? {
        guard let imageURL, let url = Self.https(imageURL), url.host == "cdn.shopify.com" else { return nil }
        return url
    }
    private static func https(_ value: String) -> URL? {
        guard let url = URL(string: value), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url
    }
}

public struct ShoppingProducts: Decodable, Sendable {
    public let products: [ShoppingProduct]
    public let fetchedAt: String
}
