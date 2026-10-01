import Foundation
import XCTest
@testable import InstantClient

final class NotificationTests: XCTestCase {
    func testOwnedSettingsRegistrationAndRevocationTransport() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [NotificationURLProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        let client = InstantClient(baseURL: URL(string: "https://push.test/instant")!, bearerToken: "alice", session: session)
        let settings = try await client.updateNotificationPreference(.tasks, enabled: false)
        XCTAssertFalse(settings.tasks); XCTAssertTrue(settings.chat); XCTAssertTrue(settings.brief)
        let receipt = try await client.registerPush(installationId: "installation", installationSecret: "secret", revision: 2,
            registrationId: "registration", token: nil, enabled: false, foreground: true)
        XCTAssertEqual(receipt.registrationId, "registration")
        try await client.revokePush(installationId: "installation", installationSecret: "secret", revision: 3, registrationId: "registration")
    }
    func testPushRoutesFenceAccountAndExpiryAndIgnoreUnknownCategories() throws {
        let registration = UUID().uuidString.lowercased()
        var data = ["version": "1", "eventId": UUID().uuidString, "registrationId": registration,
                    "targetId": UUID().uuidString, "category": "tasks", "expiresAt": "2026-10-01T01:00:00.000Z"]
        let route = try XCTUnwrap(PushRoute(data: data))
        let now = ISO8601DateFormatter().date(from: "2026-10-01T00:00:00Z")!
        XCTAssertTrue(route.isCurrent(registration: registration, now: now))
        XCTAssertFalse(route.isCurrent(registration: UUID().uuidString, now: now))
        XCTAssertFalse(route.isCurrent(registration: registration, now: now.addingTimeInterval(3600)))
        data["category"] = "echo"; XCTAssertEqual(PushRoute(data: data)?.category, .echo)
        data["category"] = "unknown"; XCTAssertNil(PushRoute(data: data))
        data["category"] = "chat"; data["version"] = "2"; XCTAssertNil(PushRoute(data: data))
    }
}
private final class NotificationURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "push.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        var bytes = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; bytes.append(buffer, count: n) }
        }
        let body = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] ?? [:]
        let valid: Bool; let response: String
        switch request.httpMethod {
        case "PATCH":
            valid = request.url?.path == "/instant/api/v1/notifications/settings" && Set(body.keys) == ["tasks"] && body["tasks"] as? Bool == false
            response = #"{"chat":true,"tasks":false,"brief":true}"#
        case "PUT":
            valid = request.url?.path == "/instant/api/v1/notifications/installations/installation" && body["token"] is NSNull && body["platform"] as? String == "ios" && body["foreground"] as? Bool == true && body["revision"] as? Int == 2
            response = #"{"registrationId":"registration"}"#
        case "DELETE":
            valid = request.url?.path == "/instant/api/v1/notifications/installations/installation" && Set(body.keys) == ["installationSecret", "registrationId", "revision"] && body["revision"] as? Int == 3
            response = #"{"revoked":true}"#
        default: valid = false; response = ""
        }
        guard valid, request.value(forHTTPHeaderField: "Authorization") == "Bearer alice" else {
            client?.urlProtocol(self, didFailWithError: InstantClientError.invalidResponse); return
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(response.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
}
