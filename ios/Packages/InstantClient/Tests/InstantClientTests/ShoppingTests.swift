import XCTest
@testable import InstantClient

final class ShoppingTests: XCTestCase {
    func testProductReferencesSurviveStreamReplayAndHistory() throws {
        let part = """
        {"type":"data-impo-products","id":"call-one","data":{"schemaVersion":1,"selectionId":"call-one","productIds":["gid://shopify/p/example"],"query":"bags","context":{"address_country":"US"}}}
        """
        var reducer = UIMessageReducer()
        try reducer.consume("{\"type\":\"start\",\"messageId\":\"message-one\"}")
        try reducer.consume(part)
        try reducer.consume(part)
        XCTAssertEqual(reducer.state.products.count, 1)
        let history = """
        {"id":"message-one","role":"assistant","sequence":2,"text":"Here are some bags.","status":"completed","createdAt":"2026-10-04T00:00:00Z","parts":[\(part)]}
        """
        let message = try JSONDecoder().decode(ConversationMessage.self, from: Data(history.utf8))
        XCTAssertEqual(message.products, reducer.state.products)
        let user = history.replacingOccurrences(of: "\"role\":\"assistant\"", with: "\"role\":\"user\"")
        XCTAssertTrue(try JSONDecoder().decode(ConversationMessage.self, from: Data(user.utf8)).products.isEmpty)
    }

    func testUnknownSchemaAndUnsafeImagesDoNotRender() throws {
        var reducer = UIMessageReducer()
        try reducer.consume("{\"type\":\"start\",\"messageId\":\"message-one\"}")
        try reducer.consume("{\"type\":\"data-impo-products\",\"data\":{\"schemaVersion\":99}}")
        XCTAssertTrue(reducer.state.products.isEmpty)
        let data = Data("""
        {"id":"test","title":"Bag","merchant":"Example","url":"javascript:alert(1)","imageURL":"https://example.com/private.png","options":[]}
        """.utf8)
        let product = try JSONDecoder().decode(ShoppingProduct.self, from: data)
        XCTAssertNil(product.merchantURL)
        XCTAssertNil(product.image)
    }
}
