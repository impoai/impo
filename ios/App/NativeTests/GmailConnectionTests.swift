import Foundation
import XCTest
import InstantClient
@testable import Instant

@MainActor
final class GmailConnectionTests: XCTestCase {
    private func model() -> (GmailConnectionModel, URLSession) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GmailStateURLProtocol.self]
        let session = URLSession(configuration: configuration)
        return (GmailConnectionModel(session: session), session)
    }

    func testServerStatusAndEndpointIdentityAreScoped() async throws {
        let (model, session) = model()
        defer { session.invalidateAndCancel(); model.pause() }
        model.configure(endpoint: URL(string: "http://connected.gmail.test")!, identityTag: "first", tokenProvider: StaticInstantToken("first"))
        model.resume()
        try await settled(model)
        XCTAssertEqual(model.connection?.status, .connected)
        XCTAssertNil(model.authorization, "Status checks must not start OAuth")

        model.configure(endpoint: URL(string: "http://connected.gmail.test")!, identityTag: "second", tokenProvider: StaticInstantToken("second"))
        XCTAssertNil(model.connection, "An account's status must not carry into another auth scope")
        model.refreshStatus()
        model.configure(endpoint: nil, identityTag: "second", tokenProvider: StaticInstantToken("second"))
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertNil(model.connection, "A stale request cannot re-enable a connection in Demo")
        XCTAssertFalse(model.isAvailable)
        XCTAssertNil(model.authorization)
    }

    func testAuthorizationNeedsExplicitConnectAndServerVerification() async throws {
        let (model, session) = model()
        defer { session.invalidateAndCancel(); model.pause() }
        model.configure(endpoint: URL(string: "http://disconnected.gmail.test")!, identityTag: "test", tokenProvider: StaticInstantToken("test"))
        model.resume()
        try await settled(model)
        XCTAssertEqual(model.connection?.status, .disconnected)
        XCTAssertNil(model.authorization)
        model.connect()
        try await settled(model)
        XCTAssertEqual(model.authorization?.url.scheme, "https")
        XCTAssertTrue(model.awaitingAuthorization)
        XCTAssertNotEqual(model.connection?.status, .connected)

        model.authorization = nil
        model.refreshStatus(checkAuthorization: true)
        try await settled(model)
        XCTAssertEqual(model.connection?.status, .disconnected, "Dismissing OAuth cannot assert success")
        XCTAssertFalse(model.awaitingAuthorization)
    }

    func testInsecureAuthorizationAndBackgroundCommandsAreRejected() async throws {
        let (model, session) = model()
        defer { session.invalidateAndCancel(); model.pause() }
        model.configure(endpoint: URL(string: "http://insecure.gmail.test")!, identityTag: "test", tokenProvider: StaticInstantToken("test"))
        model.connect()
        try await settled(model)
        XCTAssertNil(model.authorization)
        XCTAssertNotNil(model.error)
        model.pause()
        model.connect()
        XCTAssertFalse(model.isBusy)
        XCTAssertNil(model.authorization)
    }

    private func settled(_ model: GmailConnectionModel) async throws {
        for _ in 0..<200 {
            if !model.isBusy { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Connector request did not settle")
    }
}

private final class GmailStateURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".gmail.test") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        guard let url = request.url else { return }
        let json: String
        if url.path.hasSuffix("/connect") {
            let scheme = url.host == "insecure.gmail.test" ? "http" : "https"
            json = "{\"redirectURL\":\"\(scheme)://authorization.example.test/start\",\"expiresAt\":\"2026-12-01T00:00:00Z\"}"
        } else {
            json = url.host == "connected.gmail.test" ? #"{"status":"connected","email":"example@example.test"}"# : #"{"status":"disconnected"}"#
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
