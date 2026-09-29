import SwiftUI

/// Left-edge swipe to go back, for screens that are not pushed on a NavigationStack
/// (full-screen covers, sheets and in-place pages have no system back gesture).
///
/// The page follows the finger from the left edge and goes back past a distance or a quick
/// flick; otherwise it springs back. Only drags that start at the edge count, so horizontal
/// scrollers inside the page (code blocks, date rails) keep working.
struct SwipeBack: ViewModifier {
    var enabled = true
    let action: () -> Void

    @State private var offset: CGFloat = 0
    private let edge: CGFloat = 28

    func body(content: Content) -> some View {
        content
            .offset(x: offset)
            // Empty areas at the edge (between controls) must still receive the drag.
            .contentShape(Rectangle())
            .simultaneousGesture(
                DragGesture(minimumDistance: 12, coordinateSpace: .global)
                    .onChanged { value in
                        guard enabled, value.startLocation.x <= edge else { return }
                        let horizontal = value.translation.width > abs(value.translation.height)
                        offset = horizontal ? max(0, value.translation.width) : 0
                    }
                    .onEnded { value in
                        guard enabled, value.startLocation.x <= edge else { return }
                        let horizontal = value.translation.width > abs(value.translation.height)
                        if horizontal && (value.translation.width > 110 || value.predictedEndTranslation.width > 260) {
                            action()
                            offset = 0
                        } else {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { offset = 0 }
                        }
                    },
                including: enabled ? .all : .subviews
            )
            // VoiceOver's two-finger scrub performs the same back action.
            .accessibilityAction(.escape) { if enabled { action() } }
    }
}

/// Swipe-back that dismisses the presented sheet or full-screen cover it is applied to.
private struct SwipeToDismiss: ViewModifier {
    @Environment(\.dismiss) private var dismiss
    func body(content: Content) -> some View { content.modifier(SwipeBack { dismiss() }) }
}

extension View {
    func swipeBack(enabled: Bool = true, _ action: @escaping () -> Void) -> some View {
        modifier(SwipeBack(enabled: enabled, action: action))
    }
    /// Apply inside a `.sheet` / `.fullScreenCover` content closure.
    func swipeToDismiss() -> some View { modifier(SwipeToDismiss()) }
}
