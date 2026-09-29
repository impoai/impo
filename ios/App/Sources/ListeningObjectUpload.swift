import Foundation
import InstantClient

/// Presigned requests never receive the app's authentication header or cookies.
enum ListeningObjectUpload {
    @MainActor static func sync(client: InstantClient, batch: StoredListeningBatch, store: ListeningStore, wifiOnly: Bool,
                               transfer: (URLRequest, URL) async throws -> Void) async throws {
        let batches = ListeningBatchStore(store: store)
        let ticket = try await client.prepareListeningUpload(batches.uploadManifest(batch))
        let receipt: ListeningBatchReceipt
        if ticket.status == "accepted", let accepted = ticket.receipt { receipt = accepted }
        else {
            if ticket.status == "upload" { try await transfer(request(ticket, wifiOnly: wifiOnly), batches.payloadURL(batch.batchId)) }
            else if ticket.status != "uploaded" { throw InstantClientError.invalidResponse }
            try Task.checkCancellation()
            receipt = try await client.completeListeningUpload(batch.batchId)
        }
        try batches.verify(receipt, for: batch)
        try batches.removeConfirmed(batch)
        ListeningDiagnostics.shared.record("upload.receipt", ["batchId": batch.batchId, "status": "202"])
    }

    static func request(_ ticket: ListeningUploadTicket, wifiOnly: Bool) throws -> URLRequest {
        guard ticket.status == "upload", let url = ticket.url, url.scheme == "https",
              url.user == nil, url.password == nil, let headers = ticket.headers,
              Set(headers.keys.map { $0.lowercased() }).isSubset(of: ["content-type", "content-length", "x-amz-checksum-sha256"]) else {
            throw InstantClientError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.timeoutInterval = 120
        request.allowsCellularAccess = !wifiOnly
        request.httpShouldHandleCookies = false
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        return request
    }

    static func upload(_ request: URLRequest, file: URL) async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        let session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (_, response) = try await session.upload(for: request, fromFile: file)
        guard let http = response as? HTTPURLResponse else { throw InstantClientError.invalidResponse }
        guard http.statusCode == 200 else { throw InstantClientError.unexpectedHTTPStatus(http.statusCode) }
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
