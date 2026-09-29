import SwiftUI

/// Chat-style scrolling for a message list.
///
/// New content (a reply, streamed text, the user's own message) keeps the list at the latest
/// entry only while the reader is following the bottom. Once they scroll away, their position
/// never moves on its own and a "scroll to bottom" button appears. Following is decided by the
/// reader's scrolling alone: growing content must not count as "no longer at the bottom".
struct FollowsBottom: ViewModifier {
    let proxy: ScrollViewProxy
    /// ID of the view placed after the last entry.
    let bottomID: String
    /// Changes whenever entries are added or the last entry grows.
    let content: AnyHashable
    /// False while the list is filtered (search): nothing follows then.
    var enabled = true
    var identifier: String

    @State private var following = true
    @State private var atBottom = true

    func body(content view: Content) -> some View {
        view
            .defaultScrollAnchor(.bottom)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - geometry.contentInsets.bottom - 40
            } action: { _, value in atBottom = value }
            .onScrollPhaseChange { old, new in
                // A drag stops following; wherever the reader comes to rest decides whether to resume.
                if new == .interacting { following = false }
                if new == .idle, old == .interacting || old == .decelerating { following = atBottom }
            }
            .onChange(of: content) { _, _ in
                guard enabled, following else { return }
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) }
            }
            .overlay(alignment: .bottom) {
                if !following && !atBottom {
                    Button {
                        following = true
                        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(bottomID, anchor: .bottom) }
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.system(size: 15, weight: .semibold)).foregroundStyle(InstantStyle.ink)
                            .frame(width: 38, height: 38)
                            .background(InstantStyle.paperElevated, in: Circle())
                            .overlay(Circle().strokeBorder(InstantStyle.border, lineWidth: 0.8))
                            .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
                    }
                    .buttonStyle(.plain).padding(.bottom, 10)
                    .accessibilityLabel("Scroll to bottom").accessibilityIdentifier(identifier)
                    .transition(.opacity.combined(with: .scale(scale: 0.85)))
                }
            }
            .animation(.easeOut(duration: 0.15), value: !following && !atBottom)
    }
}

extension View {
    func followsBottom(_ proxy: ScrollViewProxy, bottomID: String = "bottom", content: AnyHashable, enabled: Bool = true, identifier: String) -> some View {
        modifier(FollowsBottom(proxy: proxy, bottomID: bottomID, content: content, enabled: enabled, identifier: identifier))
    }
}
