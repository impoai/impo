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

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, !activated else { return }
        activated = true
        // Wait for the sheet's first layout so selection handles get valid geometry.
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            guard let self, self.window != nil, !self.text.isEmpty else { return }
            self.becomeFirstResponder()
            self.selectedRange = NSRange(location: 0, length: 0)
            self.select(nil)
        }
    }
}
