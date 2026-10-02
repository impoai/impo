import Foundation
import XCTest
@testable import InstantClient

final class ListeningTests: XCTestCase {
    func testUploadSendsRawAudioAndStableReceiptMetadata() async throws {
        let (api, session) = client("upload")
        defer { session.invalidateAndCancel() }
        let result = try await api.uploadListeningSegment(id: "stable-id", startedAt: Date(timeIntervalSince1970: 1), endedAt: Date(timeIntervalSince1970: 5), audio: Data([1, 2, 3]))
        XCTAssertEqual(result.clientSegmentId, "stable-id")
        XCTAssertEqual(result.status, "pending")
    }
    func testListUsesExplicitDayBoundariesAndDecodesTranscript() async throws {
        let (api, session) = client("list")
        defer { session.invalidateAndCancel() }
        let result = try await api.listeningSegments(from: Date(timeIntervalSince1970: 0), to: Date(timeIntervalSince1970: 86400))
        XCTAssertEqual(result.first?.transcript, "你好")
    }
    func testDeletedUploadReturnsNonretryableError() async throws {
        let (api, session) = client("deleted")
        defer { session.invalidateAndCancel() }
        do {
            _ = try await api.uploadListeningSegment(id: "stable-id", startedAt: Date(timeIntervalSince1970: 1), endedAt: Date(timeIntervalSince1970: 5), audio: Data([1, 2, 3]))
            XCTFail("A deleted recording cannot be recreated")
        } catch let error as InstantAPIError {
            XCTAssertEqual(error.statusCode, 410); XCTAssertFalse(error.retryable)
        }
    }
    func testHistoryPreservesPaginationCursor() async throws {
        let (api, session) = client("history")
        defer { session.invalidateAndCancel() }
        let page = try await api.listeningHistory(cursor: "opaque_cursor", limit: 30)
        XCTAssertEqual(page.nextCursor, "next_cursor")
        XCTAssertEqual(page.segments.first?.transcript, "你好")
    }
    func testLocationLabelPatchAndOptionalDeviceSpans() async throws {
        let (api, session) = client("location"); defer { session.invalidateAndCancel() }
        let updated = try await api.setListeningLocationLabel("server-id", label: "Office")
        XCTAssertEqual(updated.location?.label, "Office")
        XCTAssertEqual(updated.location?.spans.first?.city, "Shanghai")
        let cleared = try await api.setListeningLocationLabel("server-id", label: nil)
        XCTAssertNil(cleared.location?.label)
        XCTAssertEqual(cleared.location?.spans.count, 1)
    }
    func testSpeakerReviewRoundTripAndUnknownVoiceDoesNotBecomeSelf() async throws {
        let (api, session) = client("speakers"); defer { session.invalidateAndCancel() }
        let review = EchoSpeakerReview(revision: 2, status: "confirmed", selfSpeakerIds: ["a"], excludedUtteranceIds: ["u3"])
        let result = try await api.reviewListeningSpeakers("server-id", review: review)
        XCTAssertEqual(result.speakerReview?.revision, 3)
        XCTAssertEqual(result.speakerIDs, ["a", "b"])
        XCTAssertEqual(result.speakerLabel("a"), "Speaker A")
        XCTAssertEqual(result.speakerLabel(nil), "Unknown speaker")
        XCTAssertTrue(result.speakerReview!.includes(result.utterances![0]))
        XCTAssertFalse(result.speakerReview!.includes(result.utterances![1]))
        XCTAssertFalse(result.speakerReview!.includes(result.utterances![2]))
        XCTAssertFalse(EchoSpeakerReview().includes(result.utterances![0]))
    }
    private func client(_ scenario: String) -> (InstantClient, URLSession) {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ListeningProtocol.self]
        let session = URLSession(configuration: config)
        return (InstantClient(baseURL: URL(string: "https://\(scenario).listening-test.invalid/instant")!, bearerToken: "test", session: session), session)
    }
}

private final class ListeningProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".listening-test.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.url?.host == "speakers.listening-test.invalid" {
            XCTAssertEqual(request.url?.path, "/instant/api/v1/listening/segments/server-id/speakers")
            XCTAssertEqual(request.httpMethod, "PATCH")
            var bytes = request.httpBody ?? Data()
            if let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }; var buffer = [UInt8](repeating: 0, count: 1024)
                while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; bytes.append(contentsOf: buffer.prefix(count)) }
            }
            var review = try! JSONDecoder().decode(EchoSpeakerReview.self, from: bytes)
            XCTAssertEqual(review.revision, 2); XCTAssertEqual(review.selfSpeakerIds, ["a"]); XCTAssertEqual(review.excludedUtteranceIds, ["u3"])
            review.revision += 1
            let body: [String: Any] = ["segment": ["id": "server-id", "clientSegmentId": "stable-id", "startedAt": "1970-01-01T00:00:01Z", "endedAt": "1970-01-01T00:00:05Z", "status": "transcribed", "transcript": "Mine. Other. Excluded.",
                "speakerReview": try! JSONSerialization.jsonObject(with: JSONEncoder().encode(review)), "utterances": [
                    ["id": "u1", "speaker": "a", "startMs": 0, "endMs": 1000, "text": "Mine."],
                    ["id": "u2", "speaker": "b", "startMs": 1100, "endMs": 2000, "text": "Other."],
                    ["id": "u3", "speaker": "a", "startMs": 2100, "endMs": 3000, "text": "Excluded."]]]]
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body)); client?.urlProtocolDidFinishLoading(self); return
        }
        if request.url?.host == "location.listening-test.invalid" {
            XCTAssertEqual(request.url?.path, "/instant/api/v1/listening/segments/server-id/location")
            XCTAssertEqual(request.httpMethod, "PATCH")
            var bytes = request.httpBody ?? Data()
            if let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }; var buffer = [UInt8](repeating:0,count:1024)
                while stream.hasBytesAvailable { let count=stream.read(&buffer,maxLength:buffer.count); if count <= 0 { break }; bytes.append(contentsOf:buffer.prefix(count)) }
            }
            let label = (try! JSONSerialization.jsonObject(with:bytes) as! [String:Any])["label"]!
            let span: [String:Any] = ["from":"1970-01-01T00:00:01Z","to":"1970-01-01T00:00:05Z","capturedAt":"1970-01-01T00:00:01Z","accuracyMeters":1000,"source":"device","granularity":"city","city":"Shanghai","country":"China"]
            let segment: [String:Any] = ["id":"server-id","clientSegmentId":"stable-id","startedAt":"1970-01-01T00:00:01Z","endedAt":"1970-01-01T00:00:05Z","status":"transcribed","transcript":"Hello","location":["label":label,"source":label is NSNull ? NSNull() : "manual","spans":[span]]]
            client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!,cacheStoragePolicy:.notAllowed)
            client?.urlProtocol(self,didLoad:try! JSONSerialization.data(withJSONObject:["segment":segment]))
            client?.urlProtocolDidFinishLoading(self); return
        }
        XCTAssertEqual(request.url?.path, "/instant/api/v1/listening/segments")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test")
        let history = request.url?.host == "history.listening-test.invalid"
        let list = request.url?.host == "list.listening-test.invalid" || history
        let deleted = request.url?.host == "deleted.listening-test.invalid"
        if list {
            let parts = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
            XCTAssertEqual(parts.queryItems, history
                ? [URLQueryItem(name: "limit", value: "30"), URLQueryItem(name: "cursor", value: "opaque_cursor")]
                : [URLQueryItem(name: "from", value: "1970-01-01T00:00:00Z"), URLQueryItem(name: "to", value: "1970-01-02T00:00:00Z")])
        } else {
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "audio/mp4")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Segment-Id"), "stable-id")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Recording-Started-At"), "1970-01-01T00:00:01.000Z")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Recording-Ended-At"), "1970-01-01T00:00:05.000Z")
        }
        let segment: [String: Any] = ["id": "server-id", "clientSegmentId": "stable-id", "startedAt": "1970-01-01T00:00:01Z", "endedAt": "1970-01-01T00:00:05Z", "status": list ? "transcribed" : "pending", "transcript": list ? "你好" : "", "model": NSNull(), "error": NSNull()]
        let body: [String: Any] = deleted ? ["error": ["code": "segment_deleted", "message": "Deleted", "retryable": false]] : list ? ["segments": [segment], "nextCursor": history ? "next_cursor" : NSNull()] : segment
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: deleted ? 410 : list ? 200 : 202, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
