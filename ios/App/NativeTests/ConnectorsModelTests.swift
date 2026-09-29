import Foundation
import XCTest
import InstantClient
@testable import Instant

@MainActor
final class ConnectorsModelTests: XCTestCase {
    private func model() -> (ConnectorsModel, URLSession) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ConnectorStateURLProtocol.self]
        let session = URLSession(configuration: configuration)
        return (ConnectorsModel(session: session), session)
    }

    func testServerStatusAndEndpointIdentityAreScoped() async throws {
        let (model, session) = model()
        defer { session.invalidateAndCancel(); model.pause() }
        model.configure(endpoint: URL(string: "http://connected.gmail.test")!, identityTag: "first", tokenProvider: StaticInstantToken("first"))
        model.resume()
        try await settled(model)
        XCTAssertTrue(model.loaded)
        XCTAssertEqual(model.connector("gmail")?.status, .connected)
        XCTAssertEqual(model.active.map(\.toolkit), ["gmail"])
        XCTAssertEqual(model.suggested.map(\.toolkit), ["googlecalendar"])
        XCTAssertEqual(model.search("ynab").map(\.toolkit), ["ynab"])
        XCTAssertEqual(model.search("").map(\.name), ["Gmail", "Google Calendar", "YNAB"])
        XCTAssertNil(model.authorization, "Loading the shelf must not start OAuth")

        model.configure(endpoint: URL(string: "http://connected.gmail.test")!, identityTag: "second", tokenProvider: StaticInstantToken("second"))
        XCTAssertTrue(model.connectors.isEmpty, "An account's status must not carry into another auth scope")
        model.reload()
        model.configure(endpoint: nil, identityTag: "second", tokenProvider: StaticInstantToken("second"))
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(model.connectors.isEmpty, "A stale request cannot re-enable a connection in Demo")
        XCTAssertFalse(model.isAvailable)
        XCTAssertNil(model.authorization)
    }

    func testAuthorizationNeedsExplicitConnectAndServerVerification() async throws {
        let (model, session) = model()
        defer { session.invalidateAndCancel(); model.pause() }
        model.configure(endpoint: URL(string: "http://disconnected.gmail.test")!, identityTag: "test", tokenProvider: StaticInstantToken("test"))
        model.resume()
        try await settled(model)
        XCTAssertEqual(model.connector("googlecalendar")?.status, .disconnected)
        XCTAssertNil(model.authorization)
        model.connect("googlecalendar")
        try await settled(model)
        XCTAssertEqual(model.authorization?.url.scheme, "https")
        XCTAssertEqual(model.authorization?.toolkit, "googlecalendar")
        XCTAssertEqual(model.awaitingToolkit, "googlecalendar")
        XCTAssertEqual(model.active.map(\.toolkit), ["googlecalendar"], "An app awaiting authorization is listed with the active ones")

        model.authorization = nil
        model.refreshStatus("googlecalendar", checkAuthorization: true)
        try await settled(model)
        XCTAssertEqual(model.connector("googlecalendar")?.status, .disconnected, "Dismissing OAuth cannot assert success")
        XCTAssertNil(model.awaitingToolkit)
    }

    func testInsecureAuthorizationAndBackgroundCommandsAreRejected() async throws {
        let (model, session) = model()
        defer { session.invalidateAndCancel(); model.pause() }
        model.configure(endpoint: URL(string: "http://insecure.gmail.test")!, identityTag: "test", tokenProvider: StaticInstantToken("test"))
        model.connect("gmail")
        try await settled(model)
        XCTAssertNil(model.authorization)
        XCTAssertNotNil(model.error)
        XCTAssertEqual(model.errorToolkit, "gmail")
        model.pause()
        model.connect("gmail")
        XCTAssertFalse(model.isBusy)
        XCTAssertNil(model.authorization)
    }

    private func settled(_ model: ConnectorsModel) async throws {
        for _ in 0..<200 {
            if !model.isBusy { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Connector request did not settle")
    }
}

private final class ConnectorStateURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".gmail.test") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        guard let url = request.url else { return }
        let json: String
        if url.path.hasSuffix("/connect") {
            let scheme = url.host == "insecure.gmail.test" ? "http" : "https"
            json = "{\"redirectURL\":\"\(scheme)://authorization.example.test/start\",\"expiresAt\":\"2026-12-01T00:00:00Z\"}"
        } else if url.path == "/api/v1/connectors" {
            let gmail = url.host == "connected.gmail.test" ? #""status":"connected","email":"example@example.test""# : #""status":"disconnected""#
            json = #"{"connectors":[{"toolkit":"gmail","name":"Gmail","featured":true,"#
                + gmail + #"},{"toolkit":"googlecalendar","name":"Google Calendar","featured":true,"status":"disconnected"},{"toolkit":"ynab","name":"YNAB","featured":false,"status":"disconnected"}]}"#
        } else {
            json = url.host == "connected.gmail.test" && url.path.hasSuffix("/gmail") ? #"{"status":"connected","email":"example@example.test"}"# : #"{"status":"disconnected"}"#
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
