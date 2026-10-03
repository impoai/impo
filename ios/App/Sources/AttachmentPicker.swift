import SwiftUI
import PhotosUI
import CryptoKit
import InstantClient
import UniformTypeIdentifiers

private struct UploadDraft: Identifiable {
    let id: String
    let name: String
    let mediaType: String
    let bytes: Data
    var error: String?
}

/// Both pickers share one upload path. Only ready, account-owned IDs enter message commands.
struct AttachmentPicker: View {
    @Environment(AppModel.self) private var model
    @Binding var files: [UploadedAttachment]
    @Binding var blocked: Bool
    var disabled = false
    @State private var importing = false
    @State private var showingPhotos = false
    @State private var pickerOwner: String?
    @State private var selectionJob: Task<Void, Never>?
    @State private var reading = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var drafts: [UploadDraft] = []
    @State private var jobs: [String: Task<Void, Never>] = [:]
    @State private var notice: String?
    private let formats = ["pdf": "application/pdf", "doc": "application/msword", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                           "txt": "text/plain", "md": "text/markdown", "csv": "text/csv", "json": "application/json",
                           "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp", "gif": "image/gif"]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top) {
                Menu {
                    Button { pickerOwner = model.listeningScope; showingPhotos = true } label: {
                        Label("Photo library", systemImage: "photo")
                    }
                    Button { pickerOwner = model.listeningScope; importing = true } label: { Label("Choose files", systemImage: "doc") }
                } label: { Label("Attach", systemImage: "plus").font(.subheadline).frame(minHeight: 44) }
                    .disabled(disabled || model.liveClient() == nil || files.count + drafts.count >= 8)
                    .accessibilityIdentifier("attachments.add")
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(files) { file in
                            HStack {
                                Image(systemName: file.mediaType.hasPrefix("image/") ? "photo" : "doc.text")
                                Text(file.name).lineLimit(1).frame(maxWidth: 170)
                                Button { files.removeAll { $0.id == file.id } } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }
                                    .accessibilityLabel("Remove \(file.name)").disabled(disabled)
                            }.font(.caption).padding(.leading, 10).background(InstantStyle.paperElevated, in: Capsule())
                        }
                        ForEach(drafts) { draft in
                            HStack {
                                if draft.error == nil { ProgressView().controlSize(.small) }
                                Text(draft.name).lineLimit(1).frame(maxWidth: 130)
                                if draft.error != nil { Button("Retry") { upload(draft) }.frame(minHeight: 44) }
                                Button { jobs.removeValue(forKey: draft.id)?.cancel(); drafts.removeAll { $0.id == draft.id }; syncBlocked() } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }
                                    .accessibilityLabel("Remove \(draft.name)")
                            }.font(.caption).padding(.leading, 10).background(InstantStyle.paperElevated, in: Capsule())
                        }
                    }
                }.scrollIndicators(.hidden)
            }
            if let notice { Text(notice).font(.caption).foregroundStyle(InstantStyle.muted) }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.data], allowsMultipleSelection: true) { result in
            guard model.listeningScope == pickerOwner else { return }
            do { for url in try result.get() { importFile(url) } }
            catch { notice = "Couldn't open that file. Try choosing it again." }
        }
        .photosPicker(isPresented: $showingPhotos, selection: $photos, maxSelectionCount: max(1, 8 - files.count - drafts.count), matching: .images)
        .onChange(of: photos) { _, selection in
            guard !selection.isEmpty, let owner = pickerOwner, model.listeningScope == owner else { return }
            selectionJob?.cancel(); reading = true; syncBlocked()
            selectionJob = Task {
                defer { if model.listeningScope == owner { reading = false; syncBlocked() } }
                for photo in selection {
                    do {
                        guard let data = try await photo.loadTransferable(type: Data.self), let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.85) else { throw InstantClientError.invalidResponse }
                        guard !Task.isCancelled, model.listeningScope == owner else { return }
                        add(name: "Photo-\(UUID().uuidString.prefix(8)).jpg", mediaType: "image/jpeg", bytes: jpeg)
                    } catch { if !Task.isCancelled, model.listeningScope == owner { notice = "Couldn't load that photo. Try choosing it again." } }
                }
                photos = []
            }
        }
        .onChange(of: model.listeningScope) { _, _ in reset() }
        .onDisappear { selectionJob?.cancel(); selectionJob = nil; reading = false; for job in jobs.values { job.cancel() }; jobs = [:]; drafts = []; syncBlocked() }
    }

    private func importFile(_ url: URL) {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard let type = formats[url.pathExtension.lowercased()] else { notice = "Choose PDF, Word, text, CSV, JSON, JPEG, PNG, GIF or WebP."; return }
        do {
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size > 0, size <= 10 * 1024 * 1024 else { notice = "Choose a file up to 10 MB."; return }
            add(name: url.lastPathComponent, mediaType: type, bytes: try Data(contentsOf: url))
        } catch { notice = "Couldn't open that file. Download it to your device and try again." }
    }
    private func add(name: String, mediaType: String, bytes: Data) {
        guard files.count + drafts.count < 8 else { notice = "Attach up to eight files per message."; return }
        guard !bytes.isEmpty, bytes.count <= 10 * 1024 * 1024 else { notice = "Choose a file up to 10 MB."; return }
        let draft = UploadDraft(id: UUID().uuidString.lowercased(), name: name, mediaType: mediaType, bytes: bytes)
        drafts.append(draft); upload(draft)
    }
    private func syncBlocked() { blocked = reading || !drafts.isEmpty }
    private func reset() { selectionJob?.cancel(); selectionJob = nil; reading = false; pickerOwner = nil; for job in jobs.values { job.cancel() }; jobs = [:]; drafts = []; files = []; photos = []; notice = nil; syncBlocked() }
    private func upload(_ draft: UploadDraft) {
        guard let client = model.liveClient(), let owner = model.listeningScope else { return }
        if let index = drafts.firstIndex(where: { $0.id == draft.id }) { drafts[index].error = nil }
        notice = nil; syncBlocked()
        jobs[draft.id] = Task {
            do {
                let checksum = SHA256.hash(data: draft.bytes).map { String(format: "%02x", $0) }.joined()
                let ticket = try await client.prepareAttachment(id: draft.id, name: draft.name, mediaType: draft.mediaType, sizeBytes: draft.bytes.count, sha256: checksum)
                try Task.checkCancellation()
                guard model.listeningScope == owner else { throw CancellationError() }
                if ticket.status == "upload" {
                    guard let url = ticket.url, url.scheme == "https", let headers = ticket.headers else { throw InstantClientError.invalidResponse }
                    var request = URLRequest(url: url); request.httpMethod = "PUT"; request.timeoutInterval = 120
                    for (name, value) in headers {
                        guard !["authorization", "cookie", "proxy-authorization", "host"].contains(name.lowercased()) else { throw InstantClientError.invalidResponse }
                        request.setValue(value, forHTTPHeaderField: name)
                    }
                    let config = URLSessionConfiguration.ephemeral
                    config.httpShouldSetCookies = false; config.urlCredentialStorage = nil
                    let session = URLSession(configuration: config, delegate: UploadRedirectBlocker(), delegateQueue: nil)
                    defer { session.invalidateAndCancel() }
                    let (_, response) = try await session.upload(for: request, from: draft.bytes)
                    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw InstantClientError.invalidResponse }
                } else if ticket.status != "uploaded" && ticket.status != "ready" { throw InstantClientError.invalidResponse }
                guard model.listeningScope == owner else { throw CancellationError() }
                let file = try await client.completeAttachment(draft.id)
                try Task.checkCancellation()
                guard model.listeningScope == owner, drafts.contains(where: { $0.id == draft.id }), file.id == draft.id, file.status == "ready" else { throw CancellationError() }
                files.append(file); drafts.removeAll { $0.id == draft.id }; jobs[draft.id] = nil; syncBlocked()
            } catch {
                guard model.listeningScope == owner, !Task.isCancelled else { return }
                if let index = drafts.firstIndex(where: { $0.id == draft.id }) { drafts[index].error = "Upload failed" }
                notice = "Upload didn't finish. Retry or remove the file before sending."; jobs[draft.id] = nil; syncBlocked()
            }
        }
    }
}

private final class UploadRedirectBlocker: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
