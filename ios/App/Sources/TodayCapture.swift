import SwiftUI
import InstantClient
import UIKit

/// A non-lazy, unconstrained document, so off-screen cards are included in the render.
struct TodayCaptureDocument: View {
    let date: String
    let briefs: [TodayBrief]
    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            HStack { Text("Impo").font(InstantStyle.serif(30)); Spacer(); Text("Today · \(date)").font(.subheadline) }
            ForEach(briefs) { brief in
                VStack(alignment: .leading, spacing: 14) {
                    Label(brief.label, systemImage: TodayPresentation.symbol(brief.kind)).font(.system(size: 18, weight: .medium))
                    TodayBriefBody(brief: brief, exporting: true)
                }
            }
            Text("A little perspective, throughout your day. · Impo").font(.caption).foregroundStyle(InstantStyle.muted)
        }.padding(28).frame(width: 430).fixedSize(horizontal: false, vertical: true)
            .foregroundStyle(InstantStyle.ink).background(InstantStyle.paper)
            .environment(\.colorScheme, .light).environment(\.dynamicTypeSize, .large)
    }
}

@MainActor enum TodayCaptureRenderer {
    static func export(date: String, briefs: [TodayBrief]) throws -> URL {
        guard !briefs.isEmpty, briefs.allSatisfy({ $0.content != nil }) else { throw TodayError.empty }
        let renderer = ImageRenderer(content: TodayCaptureDocument(date: date, briefs: briefs))
        renderer.proposedSize = ProposedViewSize(width: 430, height: nil)
        renderer.isOpaque = true
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("TodayCaptures", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // These are local export files only, never uploaded by the app.
        if let existing = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.creationDateKey]) {
            for file in existing {
                if let created = try? file.resourceValues(forKeys: [.creationDateKey]).creationDate, Date().timeIntervalSince(created) > 86_400 { try? FileManager.default.removeItem(at: file) }
            }
        }
        var size = CGSize.zero
        renderer.render { renderedSize, _ in size = renderedSize }
        guard size.width > 0, size.height > 0, size.height.isFinite else { throw TodayError.exportFailed }
        let stem = "Impo-Today-\(date)-\(UUID().uuidString)"
        if size.height <= 16_000 {
            // Cap peak bitmap allocation while keeping normal briefs at 2x resolution.
            renderer.scale = min(2, sqrt(20_000_000 / (size.width * size.height)))
            guard let data = renderer.uiImage?.pngData() else { throw TodayError.exportFailed }
            let url = folder.appendingPathComponent(stem + ".png")
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            ListeningDiagnostics.shared.record("today.capture_exported", ["briefs": String(briefs.count), "format": "png", "bytes": String(data.count)])
            return url
        }
        // Very long days use a complete paginated PDF instead of truncating or exhausting bitmap memory.
        let url = folder.appendingPathComponent(stem + ".pdf")
        let pageHeight: CGFloat = 1000
        let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: size.width, height: pageHeight))
        try pdf.writePDF(to: url) { context in
            renderer.render { size, draw in
                for offset in stride(from: CGFloat(0), to: size.height, by: pageHeight) {
                    context.beginPage(); context.cgContext.saveGState()
                    // ImageRenderer draws in Quartz coordinates; UIKit's PDF context is flipped.
                    // Flip the whole document before taking this page's top-to-bottom slice.
                    context.cgContext.translateBy(x: 0, y: size.height - offset)
                    context.cgContext.scaleBy(x: 1, y: -1)
                    draw(context.cgContext); context.cgContext.restoreGState()
                }
            }
        }
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
        ListeningDiagnostics.shared.record("today.capture_exported", ["briefs": String(briefs.count), "format": "pdf"])
        return url
    }
}

struct TodayCaptureView: View {
    @Environment(TodayModel.self) private var today
    @Environment(\.dismiss) private var dismiss
    let initialDate: String
    @State private var date = ""
    @State private var editions: [TodayBrief] = []
    @State private var url: URL?
    @State private var error: String?
    @State private var busy = true
    private var dates: [String] { Array(Set(today.briefs.map(\.localDate) + [initialDate])).sorted(by: >) }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    if busy { ProgressView("Preparing the full day…").padding(40) }
                    if let error { Text(error).padding(22) }
                    ForEach(editions) { brief in TodayBriefBody(brief: brief, exporting: true) }
                }.padding(22)
            }.background(InstantStyle.paper)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Close", systemImage: "xmark") { dismiss() }.labelStyle(.iconOnly) }
                    ToolbarItem(placement: .principal) { Picker("Capture date", selection: $date) { ForEach(dates, id: \.self) { Text($0).tag($0) } }.pickerStyle(.menu) }
                    ToolbarItem(placement: .confirmationAction) {
                        if let url { ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }.accessibilityIdentifier("today.capture-share") }
                    }
                }
                .safeAreaInset(edge: .bottom) {
                    Text("All completed briefs for \(date.isEmpty ? initialDate : date) · Full-page \(url?.pathExtension.uppercased() ?? "capture")")
                        .font(.caption).padding(12).frame(maxWidth: .infinity).background(InstantStyle.paper)
                }
        }.onAppear { date = initialDate }
            .task(id: date) {
                guard !date.isEmpty else { return }
                let selected = date; busy = true; url = nil; error = nil; editions = []
                do {
                    let rows = try await today.captureDay(selected)
                    try Task.checkCancellation()
                    guard selected == date else { return }
                    let file = try TodayCaptureRenderer.export(date: selected, briefs: rows)
                    editions = rows; url = file
                } catch is CancellationError { return }
                catch { self.error = error.localizedDescription }
                busy = false
            }
    }
}
