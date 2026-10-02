import Foundation
import XCTest
@testable import Instant

@MainActor
final class AccountProfileTests: XCTestCase {
    func testReturningProfileRestoresAndPersistsAssistantSetup() async throws {
        let suite = "AccountProfileTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AccountProfileProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let model = AppModel(defaults: defaults, session: session)
        model.useLiveBackend = true
        model.backendURL = "http://127.0.0.1:39201"
        let restored = await model.restoreAccountProfile()
        XCTAssertTrue(restored)
        XCTAssertTrue(model.isOnboarded)
        XCTAssertEqual(model.assistantName, "Robin")
        XCTAssertEqual(model.avatarIndex, 2)
        XCTAssertEqual(model.displayName, "Alex")
        XCTAssertEqual(model.mode, "Power")
        await model.refreshMode()
        XCTAssertTrue(model.modeLoaded)
        await model.selectMode("Balanced")
        XCTAssertEqual(model.mode, "Balanced")
        XCTAssertNil(model.modeError)
        let reopened = AppModel(defaults: defaults, session: session)
        XCTAssertTrue(reopened.isOnboarded)
        XCTAssertEqual(reopened.assistantName, "Robin")
        XCTAssertEqual(reopened.mode, "Balanced")
    }

    func testUnavailableProfileDoesNotCompleteOnboarding() async throws {
        let suite = "AccountProfileTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AccountProfileProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let model = AppModel(defaults: defaults, session: session)
        model.useLiveBackend = true
        model.backendURL = "http://127.0.0.1:39202"
        let restored = await model.restoreAccountProfile()
        XCTAssertFalse(restored)
        XCTAssertFalse(model.isOnboarded)
        await model.refreshMode()
        XCTAssertFalse(model.modeLoaded)
        XCTAssertNotNil(model.modeError)
    }
}

private final class AccountProfileProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let available = request.url?.port == 39201 && request.url?.path == "/api/v1/profile"
        var body = available
            ? #"{"onboarded":true,"displayName":"Alex","assistantName":"Robin","avatarIndex":2,"mode":"Power"}"#
            : #"{"error":{"code":"profile_unavailable","message":"Unavailable","retryable":true}}"#
        if available && request.httpMethod == "PATCH" { body = #"{"onboarded":true,"mode":"Balanced"}"# }
        let response = HTTPURLResponse(url: request.url!, statusCode: available ? 200 : 503, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
