import SwiftUI
import LaTeXSwiftUI

/// Structured reading stays in SwiftUI. Native range selection is allocated only
/// when requested, for the selected paragraph or a complete-response sheet.
struct AssistantMarkdown: View {
    let text: String
    @State private var snapshot: ResponseSelection?
    @State private var selectedBlock: UUID?
    @State private var frozenDocument: ResponseDocument?
    @State private var cache = ResponseDocumentCache()

    var body: some View {
        let current = frozenDocument ?? cache.document(for: text)
        ResponseBlocks(blocks: current.blocks)
            .environment(\.responseSelectionActions, ResponseSelectionActions(
                activeID: selectedBlock,
                begin: { id in frozenDocument = current; selectedBlock = id },
                end: { id in if selectedBlock == id { selectedBlock = nil; frozenDocument = nil } },
                fullResponse: { snapshot = ResponseSelection(document: current); selectedBlock = nil; frozenDocument = nil },
                copy: { UIPasteboard.general.string = current.plainText }))
            .preference(key: ResponseSelectionActiveKey.self, value: selectedBlock != nil)
            .textSelection(.disabled)
            .contentShape(Rectangle())
            .contextMenu {
                Button("Select Full Response", systemImage: "text.cursor") { snapshot = ResponseSelection(document: current) }
                Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = current.plainText }
            } preview: {
                Text(current.plainText.prefix(600)).font(.body).lineLimit(8)
                    .foregroundStyle(InstantStyle.ink).padding(18).frame(width: 300, alignment: .leading)
                    .background(InstantStyle.paperElevated.ignoresSafeArea())
            }
            .accessibilityAction(named: "Select Full Response") { snapshot = ResponseSelection(document: current) }
            .accessibilityAction(named: "Copy") { UIPasteboard.general.string = current.plainText }
            .sheet(item: $snapshot) { ResponseSelectionSheet(selection: $0) }

    }
}

private struct ResponseBlocks: View {
    let blocks: [ResponseDocument.Block]
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 17

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(blocks.indices, id: \.self) { index in
                block(blocks[index])
            }
        }
        .font(.system(size: bodySize))
        .foregroundStyle(InstantStyle.ink)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func block(_ value: ResponseDocument.Block) -> some View {
        switch value {
        case .paragraph(let inline):
            ResponseSelectableInline(value: inline, size: bodySize, semibold: false, lineSpacing: 5)
        case .heading(let level, let inline):
            ResponseSelectableInline(value: inline, size: bodySize + (level == 1 ? 6 : level == 2 ? 3 : 0), semibold: true, lineSpacing: 3)
                .padding(.top, 3)
                .accessibilityAddTraits(.isHeader)
        case .math(let source):
            ScrollView(.horizontal) {
                LaTeX(source).parsingMode(.onlyEquations).blockMode(.alwaysInline)
                    .errorMode(.original).imageRenderingMode(.template)
                    .font(.system(size: bodySize + 1))
                    .fixedSize().padding(.vertical, 8)
                    .accessibilityLabel(source)
            }
            .accessibilityIdentifier("response.math")
        case .code(let language, let code):
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(language.isEmpty ? "Code" : language).font(.system(size: 12, weight: .medium))
                        .foregroundStyle(InstantStyle.muted)
                    Spacer()
                    Button { UIPasteboard.general.string = code } label: {
                        Image(systemName: "doc.on.doc").font(.system(size: 14)).frame(width: 44, height: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel("Copy code").accessibilityIdentifier("response.copyCode")
                }.padding(.leading, 12)
                ScrollView(.horizontal) {
                    Text(verbatim: code).font(.system(size: bodySize - 3, design: .monospaced)).lineSpacing(4)
                        .fixedSize(horizontal: true, vertical: true).padding(.horizontal, 12).padding(.bottom, 12)
                }
            }
            .background(InstantStyle.border.opacity(0.20), in: RoundedRectangle(cornerRadius: 10))
            .accessibilityIdentifier("response.code")
        case .quote(let blocks):
            HStack(alignment: .top, spacing: 12) {
                Rectangle().fill(InstantStyle.sage).frame(width: 3)
                AnyView(ResponseBlocks(blocks: blocks)).foregroundStyle(InstantStyle.muted)
            }.fixedSize(horizontal: false, vertical: true).padding(.vertical, 2)
        case .list(let entries):
            VStack(alignment: .leading, spacing: 8) {
                ForEach(entries.indices, id: \.self) { index in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(entries[index].marker).foregroundStyle(InstantStyle.muted).frame(minWidth: 18, alignment: .trailing)
                        AnyView(ResponseBlocks(blocks: entries[index].blocks))
                    }
                }
            }
        case .table(let header, let columns, let rows):
            ResponseTable(header: header, columns: columns, rows: rows)
        case .divider:
            Rectangle().fill(InstantStyle.border.opacity(0.7)).frame(height: 1).padding(.vertical, 3)
        }
    }
}

struct ResponseInline: View {
    let value: ResponseDocument.Inline
    var body: some View {
        if let latex = value.latex {
            LaTeX(latex).parsingMode(.onlyEquations).blockMode(.blockViews)
                .errorMode(.original).imageRenderingMode(.template).processEscapes()
                .accessibilityLabel(value.plain)
        } else if value.markdown.isEmpty {
            Text(verbatim: value.plain)
        } else {
            Text((try? AttributedString(markdown: value.markdown,
                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))?.webLinksOnly() ?? AttributedString(value.plain))
        }
    }
}

extension AttributedString {
    /// A link to a Sandbox path or another non-web destination cannot open on the device
    /// (delivered files appear as cards instead), so it keeps only its text.
    func webLinksOnly() -> AttributedString {
        var copy = self
        let local = copy.runs.compactMap { run -> Range<AttributedString.Index>? in
            guard let url = run.link else { return nil }
            return ["http", "https", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") ? nil : run.range
        }
        for range in local { copy[range].link = nil }
        return copy
    }
}

private struct ResponseTable: View {
    let header: [ResponseDocument.Inline]
    let columns: [ResponseDocument.Column]
    let rows: [[ResponseDocument.Inline]]
    @ScaledMetric(relativeTo: .subheadline) private var textSize: CGFloat = 15

    var body: some View {
        let widths = header.indices.map { index in
            let values = [header[index].plain] + rows.compactMap { $0.indices.contains(index) ? $0[index].plain : nil }
            let maxWidth = values.map { ($0 as NSString).size(withAttributes: [.font: UIFont.systemFont(ofSize: textSize)]).width }.max() ?? 0
            return min(240 * textSize / 15, max(100, maxWidth + 24))
        }
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                row(header, widths: widths, isHeader: true)
                    .background(InstantStyle.sage.opacity(0.22))
                ForEach(rows.indices, id: \.self) { index in
                    Rectangle().fill(InstantStyle.border.opacity(0.65)).frame(height: 0.5)
                    row(rows[index], widths: widths, isHeader: false)
                        .background(index.isMultiple(of: 2) ? Color.clear : InstantStyle.border.opacity(0.10))
                }
            }
        }
        .background(InstantStyle.paperElevated)
        .clipShape(RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(InstantStyle.border.opacity(0.75), lineWidth: 0.7))
        .accessibilityIdentifier("response.table")
    }

    private func row(_ values: [ResponseDocument.Inline], widths: [CGFloat], isHeader: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(header.indices, id: \.self) { index in
                let column = columns.indices.contains(index) ? columns[index] : .leading
                let alignment: Alignment = column == .center ? .center : column == .trailing ? .trailing : .leading
                let textAlignment: TextAlignment = column == .center ? .center : column == .trailing ? .trailing : .leading
                ResponseInline(value: values.indices.contains(index) ? values[index] : .init(markdown: "", plain: "", latex: nil))
                    .font(.system(size: textSize, weight: isHeader ? .semibold : .regular))
                    .lineSpacing(4).multilineTextAlignment(textAlignment)
                    .padding(12).frame(width: widths[index], alignment: alignment)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Layout passes reuse the last parse. Keep just one snapshot per visible answer.
@MainActor private final class ResponseDocumentCache {
    private var source: String?
    private var parsed = ResponseDocument("")
    func document(for text: String) -> ResponseDocument {
        if source != text { parsed = ResponseDocument(text); source = text }
        return parsed
    }
}
