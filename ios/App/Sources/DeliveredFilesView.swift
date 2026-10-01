import SwiftUI
import QuickLook
import UniformTypeIdentifiers
import InstantClient

/// Files an assistant reply delivered. Tapping one downloads it into the account's
/// file cache once, then opens Quick Look, which also offers Share and Save to Files.
struct DeliveredFilesView: View {
    let files: [DeliveredFile]
    @Environment(AppModel.self) private var model
    @State private var loading: String?
    @State private var preview: URL?
    @State private var error: String?
    @State private var downloadTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(files) { file in
                Button { open(file) } label: { card(file) }
                    .buttonStyle(.plain)
                    .disabled(loading != nil)
                    .accessibilityLabel("\(file.name), \(Self.size(file.sizeBytes))")
                    .accessibilityHint("Opens the file")
                    .accessibilityIdentifier("message.file")
            }
            if let error {
                Text(error).font(.system(size: 14)).foregroundStyle(InstantStyle.muted)
            }
        }
        .quickLookPreview($preview)
        .onDisappear { downloadTask?.cancel() }
    }

    private func card(_ file: DeliveredFile) -> some View {
        HStack(spacing: 12) {
            Image(systemName: Self.symbol(file)).font(.system(size: 22)).foregroundStyle(InstantStyle.accent)
                .frame(width: 40, height: 40).background(InstantStyle.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name).font(.system(size: 16, weight: .medium)).foregroundStyle(InstantStyle.ink)
                    .lineLimit(2).multilineTextAlignment(.leading)
                Text(Self.size(file.sizeBytes)).font(.system(size: 13)).foregroundStyle(InstantStyle.muted)
            }
            Spacer(minLength: 8)
            if loading == file.fileId { ProgressView().controlSize(.small) }
            else { Image(systemName: "arrow.down.circle").font(.system(size: 20)).foregroundStyle(InstantStyle.muted) }
        }
        .padding(.horizontal, 12).padding(.vertical, 10).frame(minHeight: 60)
        .frame(maxWidth: 360, alignment: .leading)
        .paperSurface(cornerRadius: 14)
        .contentShape(RoundedRectangle(cornerRadius: 14))
    }

    private func open(_ file: DeliveredFile) {
        loading = file.fileId; error = nil
        downloadTask = Task {
            defer { loading = nil }
            do { preview = try await model.downloadFile(file) }
            catch is CancellationError { }
            catch { self.error = "Couldn't open \(file.name). Check your connection and try again." }
        }
    }

    static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    static func symbol(_ file: DeliveredFile) -> String {
        guard let type = UTType(mimeType: file.mediaType) ?? UTType(filenameExtension: (file.name as NSString).pathExtension) else { return "doc" }
        if type.conforms(to: .pdf) { return "doc.richtext" }
        if type.conforms(to: .image) { return "photo" }
        if type.conforms(to: .audio) { return "waveform" }
        if type.conforms(to: .movie) { return "film" }
        if type.conforms(to: .spreadsheet) { return "tablecells" }
        if type.conforms(to: .presentation) { return "rectangle.on.rectangle" }
        if type.conforms(to: .archive) { return "doc.zipper" }
        if type.conforms(to: .text) { return "doc.text" }
        return "doc"
    }
}

/// Downloaded reply files. Cleared with the rest of an account's local state.
enum DeliveredFileCache {
    static var directory: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("DeliveredFiles", isDirectory: true)
    }
    static func clear() { try? FileManager.default.removeItem(at: directory) }
}
