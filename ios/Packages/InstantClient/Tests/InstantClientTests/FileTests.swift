import Foundation
import XCTest
@testable import InstantClient

final class FileTests: XCTestCase {
    private let fileId = "3f1c2b7a-4d5e-4f60-8a9b-0c1d2e3f4a5b_artifact_036c9b83"

    func testReducerCollectsDeliveredFilesOnceAndIgnoresMalformedParts() throws {
        var reducer = UIMessageReducer()
        for event in [
            #"{"type":"start","messageId":"assistant-1"}"#,
            #"{"type":"text-start","id":"text-1"}"#,
            #"{"type":"text-delta","id":"text-1","delta":"已完成 PDF。"}"#,
            #"{"type":"text-end","id":"text-1"}"#,
            #"{"type":"data-instant-file","id":"f1","data":{"schemaVersion":1,"fileId":"f1","name":"语言模型后训练.pdf","mediaType":"application/pdf","sizeBytes":102597}}"#,
            #"{"type":"data-instant-file","id":"f1","data":{"schemaVersion":1,"fileId":"f1","name":"语言模型后训练.pdf","mediaType":"application/pdf","sizeBytes":102597}}"#,
            #"{"type":"data-instant-file","id":"f2","data":{"schemaVersion":2,"fileId":"f2","name":"x.pdf","mediaType":"application/pdf","sizeBytes":1}}"#,
            #"{"type":"data-instant-file","id":"f3","data":{"schemaVersion":1,"fileId":"f3","name":"","mediaType":"text/plain","sizeBytes":1}}"#,
            #"{"type":"data-instant-file","data":{"schemaVersion":1,"fileId":"huge","name":"x","mediaType":"text/plain","sizeBytes":1e100}}"#,
            #"{"type":"finish"}"#, "[DONE]",
        ] { try reducer.consume(event) }
        XCTAssertEqual(reducer.state.files, [DeliveredFile(fileId: "f1", name: "语言模型后训练.pdf", mediaType: "application/pdf", sizeBytes: 102597)])
        XCTAssertEqual(reducer.state.text, "已完成 PDF。")
    }

    func testHistoryMessageDecodesFileParts() throws {
        let json = #"{"id":"a","role":"assistant","sequence":2,"text":"Done","status":"completed","createdAt":"2026-10-01T00:00:00Z","parts":[{"type":"text","text":"Done"},{"type":"data-instant-file","id":"f1","data":{"schemaVersion":1,"fileId":"f1","name":"report.xlsx","mediaType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","sizeBytes":12}}]}"#
        let message = try JSONDecoder().decode(ConversationMessage.self, from: Data(json.utf8))
        XCTAssertEqual(message.files.map(\.name), ["report.xlsx"])
        let plain = try JSONDecoder().decode(ConversationMessage.self, from: Data(#"{"id":"u","role":"user","sequence":1,"text":"hi","status":"completed","createdAt":"2026-10-01T00:00:00Z"}"#.utf8))
        XCTAssertEqual(plain.files, [])
    }

    func testLocalNameIsOneSafePathComponent() {
        XCTAssertEqual(DeliveredFile(fileId: "f", name: "../a/b:c.pdf", mediaType: "", sizeBytes: 0).localName, "_a_b_c.pdf")
        XCTAssertEqual(DeliveredFile(fileId: "f", name: " . ", mediaType: "", sizeBytes: 0).localName, "file")
    }

    func testDownloadStoresTheFileOnceAndReportsServerErrors() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FileURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = InstantClient(baseURL: URL(string: "http://instant-files.test")!, bearerToken: "files-test", session: session)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let file = DeliveredFile(fileId: fileId, name: "后训练 指南.pdf", mediaType: "application/pdf", sizeBytes: 8)
        let url = try await client.downloadFile(file, into: directory)
        XCTAssertEqual(url.lastPathComponent, "后训练 指南.pdf")
        XCTAssertEqual(try Data(contentsOf: url), Data("%PDF-1.4".utf8))
        // A second open reuses the stored copy without another request.
        let again = try await client.downloadFile(file, into: directory)
        XCTAssertEqual(again, url)

        let missing = DeliveredFile(fileId: "3f1c2b7a-4d5e-4f60-8a9b-0c1d2e3f4a5b_artifact_gone", name: "gone.pdf", mediaType: "application/pdf", sizeBytes: 1)
        do {
            _ = try await client.downloadFile(missing, into: directory)
            XCTFail("a missing file must fail")
        } catch let error as InstantAPIError {
            XCTAssertEqual(error.statusCode, 404)
            XCTAssertEqual(error.code, "not_found")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent(missing.fileId).path))
    }

    func testAccountChangeAndIncompleteDownloadsNeverBecomeCachedFiles() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FileURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = InstantClient(baseURL: URL(string: "http://instant-files.test")!, bearerToken: "files-test", session: session)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = DeliveredFile(fileId: fileId, name: "private.pdf", mediaType: "application/pdf", sizeBytes: 8)
        let validator = FileAccountValidator()
        do {
            _ = try await client.downloadFile(file, into: directory) { try await validator.validate() }
            XCTFail("Changed account must reject the completed download")
        } catch is CancellationError { }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        let wrongSize = DeliveredFile(fileId: fileId, name: "partial.pdf", mediaType: "application/pdf", sizeBytes: 9)
        do { _ = try await client.downloadFile(wrongSize, into: directory); XCTFail("Incomplete files must not be cached") }
        catch InstantClientError.invalidResponse { }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        _ = try await client.downloadFile(file, into: directory)
        do {
            _ = try await client.downloadFile(file, into: directory) { throw CancellationError() }
            XCTFail("Cached files still require the current account")
        } catch is CancellationError { }
        let escaped = DeliveredFile(fileId: "../outside", name: "private.pdf", mediaType: "application/pdf", sizeBytes: 8)
        do { _ = try await client.downloadFile(escaped, into: directory); XCTFail("IDs cannot be paths") }
        catch InstantClientError.invalidIdentifier { }
    }
}

private actor FileAccountValidator {
    private var calls = 0
    func validate() throws { calls += 1; if calls > 1 { throw CancellationError() } }
}

private final class FileURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "instant-files.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, request.httpMethod == "GET", url.path.hasPrefix("/api/v1/files/"),
              request.value(forHTTPHeaderField: "Authorization") == "Bearer files-test" else {
            client?.urlProtocol(self, didFailWithError: InstantClientError.invalidResponse)
            return
        }
        let found = url.lastPathComponent.hasSuffix("artifact_036c9b83")
        let body = found ? Data("%PDF-1.4".utf8) : Data(#"{"error":{"code":"not_found","message":"File not found","retryable":false},"requestId":"r"}"#.utf8)
        let response = HTTPURLResponse(url: url, statusCode: found ? 200 : 404, httpVersion: nil,
                                       headerFields: ["Content-Type": found ? "application/pdf" : "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}
