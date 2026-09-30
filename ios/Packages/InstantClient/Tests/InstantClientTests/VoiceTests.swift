import Foundation
import XCTest
@testable import InstantClient

final class VoiceTests: XCTestCase {
    private func client() -> (InstantClient, URLSession) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [VoiceURLProtocol.self]
        let session = URLSession(configuration: configuration)
        return (InstantClient(baseURL: URL(string: "http://instant-voice.test")!, bearerToken: "voice-test", session: session), session)
    }

    func testVoiceMessageSendsBase64AudioAndReturnsTranscribedText() async throws {
        let (client, session) = client()
        defer { session.invalidateAndCancel() }
        let receipt = try await client.sendVoiceMessage(clientMessageId: "voice-1", audio: Data([0, 1, 2, 250]), mimeType: "audio/mp4",
            deviceId: "11111111-1111-4111-8111-111111111111",
            clientContext: MessageClientContext(timeZone: "Asia/Shanghai", currentDate: "2026-10-01T00:00:00Z"))
        XCTAssertEqual(receipt, VoiceMessageReceipt(messageId: "message-1", submissionId: "submission-1", text: "帮我规划今天"))
    }

    func testTranscriptionReturnsTextAndSilenceIsATypedError() async throws {
        let (client, session) = client()
        defer { session.invalidateAndCancel() }
        let text = try await client.transcribeVoice(audio: Data([9]), mimeType: "audio/mp4")
        XCTAssertEqual(text, "Plan my day")
        do {
            _ = try await client.transcribeVoice(audio: Data([0]), mimeType: "audio/mp4")
            XCTFail("Silence must not produce text")
        } catch let error as InstantAPIError {
            XCTAssertEqual(error.statusCode, 422)
            XCTAssertEqual(error.code, "empty_transcript")
        }
    }
}

/// Deterministic transport fixture; validates the exact request body the server expects.
private final class VoiceURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "instant-voice.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard request.httpMethod == "POST", request.value(forHTTPHeaderField: "Authorization") == "Bearer voice-test",
              let data = Self.body(of: request),
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            client?.urlProtocol(self, didFailWithError: InstantClientError.invalidResponse)
            return
        }
        let (status, response): (Int, String)
        switch (request.url?.path, body["audio"] as? String) {
        case ("/api/v1/conversation/voice-messages", "AAEC+g=="?)
            where body["clientMessageId"] as? String == "voice-1" && body["mimeType"] as? String == "audio/mp4"
                && body["deviceId"] as? String == "11111111-1111-4111-8111-111111111111"
                && (body["clientContext"] as? [String: String])?["timeZone"] == "Asia/Shanghai":
            (status, response) = (202, #"{"messageId":"message-1","submissionId":"submission-1","text":"帮我规划今天"}"#)
        case ("/api/v1/voice/transcriptions", "CQ=="?) where Set(body.keys) == ["audio", "mimeType"]:
            (status, response) = (200, #"{"text":"Plan my day"}"#)
        case ("/api/v1/voice/transcriptions", "AA=="?):
            (status, response) = (422, #"{"error":{"code":"empty_transcript","message":"No speech was recognized","retryable":false}}"#)
        default:
            client?.urlProtocol(self, didFailWithError: InstantClientError.invalidResponse)
            return
        }
        let http = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(response.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    private static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
