import Foundation
import XCTest
@testable import InstantClient

final class ConnectorTests: XCTestCase {
    func testStatusDecodesEachConnectionStateAndOptionalAccountFields() async throws {
        for state in ["disconnected", "pending", "connected", "expired"] {
            let (client, session) = fixture("status-\(state)")
            defer { session.invalidateAndCancel() }
            let result = try await client.connectorStatus("gmail")
            XCTAssertEqual(result.status.rawValue, state)
            XCTAssertEqual(result.email, state == "connected" ? "reader@example.test" : nil)
            XCTAssertEqual(result.expiresAt, state == "pending" ? "2026-09-23T00:00:00Z" : nil)
        }
    }

    func testConnectPostsEmptyObjectAndDecodesAuthorizationURL() async throws {
        let (client, session) = fixture("connect")
        defer { session.invalidateAndCancel() }
        let result = try await client.connectConnector("gmail")
        XCTAssertEqual(result.redirectURL, "https://connect.example.test/authorize?state=synthetic")
        XCTAssertEqual(result.expiresAt, "2026-09-23T00:00:00Z")
    }

    func testRefreshPostsEmptyObjectAndDecodesConnectedAccount() async throws {
        let (client, session) = fixture("refresh")
        defer { session.invalidateAndCancel() }
        let result = try await client.refreshConnector("gmail")
        XCTAssertEqual(result.status, .connected)
        XCTAssertEqual(result.email, "reader@example.test")
    }

    func testDisconnectUsesDeleteWithoutRequestBody() async throws {
        let (client, session) = fixture("disconnect")
        defer { session.invalidateAndCancel() }
        let result = try await client.disconnectConnector("gmail")
        XCTAssertEqual(result.status, .disconnected)
        XCTAssertNil(result.email)
        XCTAssertNil(result.expiresAt)
    }

    func testConnectorFailurePreservesStructuredAPIError() async throws {
        let (client, session) = fixture("error")
        defer { session.invalidateAndCancel() }
        do {
            _ = try await client.connectorStatus("gmail")
            XCTFail("Expected the API's connector error")
        } catch let error as InstantAPIError {
            XCTAssertEqual(error.statusCode, 409)
            XCTAssertEqual(error.code, "connector_connection_required")
            XCTAssertEqual(error.message, "Connect Gmail first")
            XCTAssertFalse(error.retryable)
            XCTAssertEqual(error.requestId, "synthetic-request")
        }
    }

    func testListDecodesTheShelfWithOptionalMetadata() async throws {
        let (client, session) = fixture("list")
        defer { session.invalidateAndCancel() }
        let result = try await client.connectors()
        XCTAssertEqual(result.map(\.toolkit), ["gmail", "ynab"])
        XCTAssertEqual(result[0].connection, ConnectorStatus(status: .connected, email: "reader@example.test"))
        XCTAssertTrue(result[0].featured)
        XCTAssertEqual(result[1].name, "YNAB")
        XCTAssertNil(result[1].logoURL)
        XCTAssertEqual(result[1].status, .disconnected)
    }

    private func fixture(_ scenario: String) -> (InstantClient, URLSession) {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [GmailFixtureProtocol.self]
        let session = URLSession(configuration: config)
        return (InstantClient(baseURL: URL(string: "https://\(scenario).gmail-test.invalid")!, bearerToken: "swift-gmail-test", session: session), session)
    }
}

/// Every request carries its scenario in its test-only origin. There is no
/// shared mutable handler or response queue for concurrent tests to overwrite.
private final class GmailFixtureProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".gmail-test.invalid") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let scenario = String(request.url!.host!.split(separator: ".")[0])
            let operation = scenario.hasPrefix("status-") || scenario == "error" ? "status" : scenario
            let method = operation == "disconnect" ? "DELETE" : ["connect", "refresh"].contains(operation) ? "POST" : "GET"
            let path = operation == "list" ? "/api/v1/connectors" : "/api/v1/connectors/gmail" + (["connect", "refresh"].contains(operation) ? "/\(operation)" : "")
            XCTAssertEqual(request.httpMethod, method)
            XCTAssertEqual(request.url?.path, path)
            XCTAssertNil(request.url?.query)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer swift-gmail-test")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            let data = try requestData()
            if method == "POST" {
                let value = try JSONSerialization.jsonObject(with: XCTUnwrap(data))
                XCTAssertEqual((value as? [String: Any])?.count, 0)
            } else {
                XCTAssertTrue(data == nil || data!.isEmpty)
            }
            let body: [String: Any]
            let status: Int
            if scenario == "error" {
                status = 409
                body = ["error": ["code": "connector_connection_required", "message": "Connect Gmail first", "retryable": false], "requestId": "synthetic-request"]
            } else if scenario == "list" {
                status = 200
                body = ["connectors": [
                    ["toolkit": "gmail", "name": "Gmail", "description": "Mail", "logoURL": "https://logos.example.test/gmail", "featured": true, "status": "connected", "email": "reader@example.test"],
                    ["toolkit": "ynab", "name": "YNAB", "featured": false, "status": "disconnected"],
                ]]
            } else if scenario == "connect" {
                status = 200
                body = ["redirectURL": "https://connect.example.test/authorize?state=synthetic", "expiresAt": "2026-09-23T00:00:00Z"]
            } else {
                status = 200
                let state = scenario == "refresh" ? "connected" : scenario == "disconnect" ? "disconnected" : String(scenario.dropFirst("status-".count))
                body = ["status": state, "email": state == "connected" ? "reader@example.test" : NSNull(), "expiresAt": state == "pending" ? "2026-09-23T00:00:00Z" : NSNull()]
            }
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: body))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}

    private func requestData() throws -> Data? {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var bytes = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&bytes, maxLength: bytes.count)
            if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
            if count == 0 { break }
            data.append(contentsOf: bytes.prefix(count))
        }
        return data
    }
}
