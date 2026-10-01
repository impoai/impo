import SwiftUI
import UIKit

struct ResponseSelection: Identifiable {
    let id = UUID()
    let document: ResponseDocument
}

struct ResponseSelectionSheet: View {
    let selection: ResponseSelection
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SelectableResponseText(text: selection.document.plainText)
                .background(InstantStyle.paperElevated)
                .navigationTitle("Select Text")
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(InstantStyle.paperElevated, for: .navigationBar)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { dismiss() }.accessibilityIdentifier("response.selection.done")
                    }
                    ToolbarItem(placement: .primaryAction) {
                        Button("Copy All", systemImage: "doc.on.doc") {
                            UIPasteboard.general.string = selection.document.plainText
                        }.accessibilityIdentifier("response.selection.copyAll")
                    }
                }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .tint(InstantStyle.forest)
    }
}

/// A fixed snapshot: streaming and message-list updates cannot move the selection.
struct SelectableResponseText: UIViewRepresentable {
    let text: String
    @Environment(\.dynamicTypeSize) private var typeSize

    func makeUIView(context: Context) -> ResponseTextView {
        let view = ResponseTextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = true
        view.alwaysBounceVertical = true
        view.backgroundColor = .clear
        view.textColor = UIColor(InstantStyle.ink)
        view.tintColor = UIColor(InstantStyle.forest)
        view.textContainerInset = UIEdgeInsets(top: 20, left: 20, bottom: 32, right: 20)
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
        view.accessibilityIdentifier = "response.selection.text"
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: ResponseTextView, context: Context) {
        let font = UIFont.preferredFont(forTextStyle: .body)
        guard view.text != text || view.font != font else { return }
        let previous = view.selectedRange
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 5
        view.attributedText = NSAttributedString(string: text, attributes: [
            .font: font, .foregroundColor: UIColor(InstantStyle.ink), .paragraphStyle: paragraph
        ])
        if previous.location + previous.length <= (text as NSString).length { view.selectedRange = previous }
    }
}

final class ResponseTextView: UITextView {
    private var activated = false
    var onSelectionEnd: (() -> Void)?

    override func resignFirstResponder() -> Bool {
        let wasFirstResponder = isFirstResponder
        let result = super.resignFirstResponder()
        if result, wasFirstResponder, let onSelectionEnd { Task { @MainActor in onSelectionEnd() } }
        return result
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, !activated else { return }
        activated = true
        // Wait for the first layout so selection handles get valid geometry.
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            guard let self, self.window != nil, !self.text.isEmpty else { return }
            self.becomeFirstResponder()
            self.selectedRange = NSRange(location: 0, length: 0)
            self.select(nil)
        }
    }
}

struct ResponseSelectionActiveKey: PreferenceKey {
    static var defaultValue: Bool { false }
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

struct ResponseSelectionActions {
    let activeID: UUID?
    let begin: (UUID) -> Void
    let end: (UUID) -> Void
    let fullResponse: () -> Void
    let copy: () -> Void
}

private struct ResponseSelectionActionsKey: EnvironmentKey {
    static var defaultValue: ResponseSelectionActions? { nil }
}

extension EnvironmentValues {
    var responseSelectionActions: ResponseSelectionActions? {
        get { self[ResponseSelectionActionsKey.self] }
        set { self[ResponseSelectionActionsKey.self] = newValue }
    }
}

/// Allocate a native selector only for the paragraph being selected. The rest of
/// the conversation keeps its lightweight SwiftUI layout, including math/tables.
struct ResponseSelectableInline: View {
    let value: ResponseDocument.Inline
    let size: CGFloat
    let semibold: Bool
    let lineSpacing: CGFloat
    @Environment(\.responseSelectionActions) private var actions
    @State private var id = UUID()
    @State private var readingHeight: CGFloat = 0

    var body: some View {
        if let actions, actions.activeID == id {
            InlineResponseText(value: value, size: size, semibold: semibold, lineSpacing: lineSpacing) { actions.end(id) }
                .frame(minHeight: readingHeight, alignment: .topLeading)
        } else if value.latex == nil, let actions {
            reading
                .contextMenu {
                    Button("Select Text", systemImage: "text.cursor") { actions.begin(id) }
                    Button("Select Full Response", systemImage: "text.alignleft", action: actions.fullResponse)
                    Button("Copy", systemImage: "doc.on.doc", action: actions.copy)
                }
                .accessibilityAction(named: "Select Text") { actions.begin(id) }
        } else { reading }
    }

    private var reading: some View {
        ResponseInline(value: value).font(.system(size: size, weight: semibold ? .semibold : .regular))
            .lineSpacing(lineSpacing).fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { readingHeight = $0 }
    }
}

struct InlineResponseText: UIViewRepresentable {
    let value: ResponseDocument.Inline
    let size: CGFloat
    let semibold: Bool
    let lineSpacing: CGFloat
    let onEnd: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> ResponseTextView {
        let view = ResponseTextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.tintColor = UIColor(InstantStyle.forest)
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.delegate = context.coordinator
        view.accessibilityIdentifier = "response.selection.inline"
        return view
    }

    func updateUIView(_ view: ResponseTextView, context: Context) {
        context.coordinator.onEnd = onEnd
        view.onSelectionEnd = onEnd
        let attributed = Self.attributed(value, size: size, semibold: semibold, lineSpacing: lineSpacing)
        // Do not reset text or selection during unrelated SwiftUI layout passes.
        if !view.attributedText.isEqual(to: attributed) { view.attributedText = attributed }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ResponseTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }
        return CGSize(width: width, height: ceil(uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height))
    }

    static func attributed(_ value: ResponseDocument.Inline, size: CGFloat, semibold: Bool, lineSpacing: CGFloat) -> NSAttributedString {
        let markdown = (try? AttributedString(markdown: value.markdown,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))?.webLinksOnly() ?? AttributedString(value.plain)
        let source = value.markdown.isEmpty ? AttributedString(value.plain) : markdown
        let result = NSMutableAttributedString(string: "")
        let paragraph = NSMutableParagraphStyle(); paragraph.lineSpacing = lineSpacing
        for run in source.runs {
            let intent = run.inlinePresentationIntent ?? []
            var font = intent.contains(.code) ? UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
                : UIFont.systemFont(ofSize: size, weight: intent.contains(.stronglyEmphasized) ? .bold : semibold ? .semibold : .regular)
            if intent.contains(.emphasized), let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.traitItalic)) {
                font = UIFont(descriptor: descriptor, size: size)
            }
            var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor(InstantStyle.ink), .paragraphStyle: paragraph]
            if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let link = run.link { attributes[.link] = link }
            result.append(NSAttributedString(string: String(source[run.range].characters), attributes: attributes))
        }
        return result
    }

    @MainActor final class Coordinator: NSObject, UITextViewDelegate {
        var onEnd: (() -> Void)?
        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            let done = UIAction(title: "Done", image: UIImage(systemName: "checkmark")) { [weak self, weak textView] _ in
                textView?.resignFirstResponder(); self?.onEnd?()
            }
            // Keep the exit action on the first menu page, including narrow phones.
            return UIMenu(children: [done] + suggestedActions)
        }
    }
}
