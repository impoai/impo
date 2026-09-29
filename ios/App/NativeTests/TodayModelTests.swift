import XCTest
import Foundation
import InstantClient
@testable import Instant

@MainActor final class TodayModelTests: XCTestCase {
    func testCancelledRefreshDoesNotShowFailureAndNextRefreshWorks() async throws {
        let (model, session) = makeModel("hold")
        defer { session.invalidateAndCancel() }
        let refresh = Task { await model.refresh() }
        while !model.isLoading { await Task.yield() }
        // Allow URLSession to start, then mimic SwiftUI cancelling its view task.
        try await Task.sleep(for: .milliseconds(100))
        refresh.cancel()
        await refresh.value
        XCTAssertNil(model.error)
        XCTAssertFalse(model.isLoading)
        let next = InstantClient(baseURL: URL(string: "https://empty.today-test.invalid/instant")!, bearerToken: "test", session: session)
        model.configure(scope: "user", client: next)
        await model.refresh()
        XCTAssertNil(model.error)
        XCTAssertFalse(model.isLoading)
        XCTAssertTrue(model.briefs.isEmpty)
        XCTAssertFalse(model.hasMore)
    }
    func testURLSessionCancellationIsNotAVisibleErrorEvenWithoutTaskCancellation() async {
        let (model, session) = makeModel("cancel")
        defer { session.invalidateAndCancel() }
        await model.refresh()
        XCTAssertNil(model.error)
        XCTAssertFalse(model.isLoading)
        await model.syncContext(displayName: "Test")
        XCTAssertNil(model.error)
    }
    func testRealHTTPAndNetworkFailuresRemainVisibleAndRecover() async {
        for scenario in ["server-error", "offline"] {
            let (model, session) = makeModel(scenario)
            defer { session.invalidateAndCancel() }
            await model.refresh()
            XCTAssertNotNil(model.error, scenario)
            XCTAssertFalse(model.isLoading)
            model.configure(scope: "user", client: InstantClient(baseURL: URL(string: "https://empty.today-test.invalid/instant")!, bearerToken: "test", session: session))
            await model.refresh()
            XCTAssertNil(model.error, "A successful empty response clears the previous failure")
        }
    }
    private func makeModel(_ scenario: String) -> (TodayModel, URLSession) {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [TodayModelProtocol.self]
        let session = URLSession(configuration: config)
        let model = TodayModel()
        model.configure(scope: "user", client: InstantClient(baseURL: URL(string: "https://\(scenario).today-test.invalid/instant")!, bearerToken: "test", session: session))
        return (model, session)
    }
}

private final class TodayModelProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".today-test.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let scenario = request.url!.host!.components(separatedBy: ".")[0]
        if scenario == "hold" { return }
        if scenario == "cancel" || scenario == "offline" {
            client?.urlProtocol(self, didFailWithError: URLError(scenario == "cancel" ? .cancelled : .notConnectedToInternet)); return
        }
        XCTAssertEqual(request.url?.path, "/instant/api/v1/today/briefs")
        XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems, [URLQueryItem(name: "limit", value: "10")])
        let failed = scenario == "server-error"
        let body = failed ? #"{"error":{"code":"internal_error","message":"Server error","retryable":true},"requestId":"today-test-request"}"# : #"{"briefs":[],"nextCursor":null}"#
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: failed ? 500 : 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
