import Foundation
import XCTest
@testable import InstantClient

final class MemoriesTests: XCTestCase {
    func testSummaryDecodesPerCategoryCounts() async throws {
        let (client, session) = fixture("summary")
        defer { session.invalidateAndCancel() }
        let summary = try await client.memorySummary()
        XCTAssertEqual(summary.total, 3)
        XCTAssertEqual(summary.categories, ["health": 2, "food": 1, "future_category": 1])
    }

    func testCategoryPageSendsFilterAndCursorAndDecodesMemories() async throws {
        let (client, session) = fixture("page")
        defer { session.invalidateAndCancel() }
        let page = try await client.memories(category: "health", cursor: "abc", limit: 20)
        XCTAssertEqual(page.nextCursor, "next")
        XCTAssertEqual(page.memories.first?.content, "Allergic to peanuts")
        XCTAssertEqual(page.memories.first?.categories, ["health", "food"])
        XCTAssertNil(page.memories.first?.expiresAt)
    }

    func testDeleteUsesMemoryPath() async throws {
        let (client, session) = fixture("delete")
        defer { session.invalidateAndCancel() }
        try await client.deleteMemory("11111111-1111-4111-8111-111111111111")
    }

    private func fixture(_ scenario: String) -> (InstantClient, URLSession) {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MemoriesFixtureProtocol.self]
        let session = URLSession(configuration: config)
        return (InstantClient(baseURL: URL(string: "https://\(scenario).memories-test.invalid")!, bearerToken: "swift-memories-test", session: session), session)
    }
}

private final class MemoriesFixtureProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".memories-test.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let scenario = String(request.url!.host!.split(separator: ".")[0])
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer swift-memories-test")
        let body: [String: Any]
        switch scenario {
        case "summary":
            XCTAssertEqual(request.httpMethod, "GET"); XCTAssertEqual(request.url?.path, "/api/v1/memories/summary")
            body = ["total": 3, "categories": ["health": 2, "food": 1, "future_category": 1]]
        case "page":
            XCTAssertEqual(request.httpMethod, "GET"); XCTAssertEqual(request.url?.path, "/api/v1/memories")
            let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems ?? []
            XCTAssertEqual(Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") }), ["limit": "20", "category": "health", "cursor": "abc"])
            body = ["memories": [["id": "m-1", "content": "Allergic to peanuts", "categories": ["health", "food"], "sourceIds": ["chat:1"],
                                  "createdAt": "2026-09-29T00:00:00.000Z", "updatedAt": "2026-09-29T00:00:00.000Z", "expiresAt": NSNull()]], "nextCursor": "next"]
        default:
            XCTAssertEqual(request.httpMethod, "DELETE"); XCTAssertEqual(request.url?.path, "/api/v1/memories/11111111-1111-4111-8111-111111111111")
            body = ["status": "deleted"]
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
