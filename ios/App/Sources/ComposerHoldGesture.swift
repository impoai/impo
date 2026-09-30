import SwiftUI

/// A real hold across the composer. Taps continue to the text view/buttons;
/// recognition cancels their touch and tracks the finger until release.
struct ComposerHoldGesture: UIGestureRecognizerRepresentable {
    var enabled: Bool
    var onBegan: () -> Void
    var onMoved: (Bool) -> Void
    var onEnded: () -> Void
    var onCancelled: () -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UILongPressGestureRecognizer {
        let recognizer = UILongPressGestureRecognizer()
        recognizer.minimumPressDuration = 0.35
        recognizer.allowableMovement = 12
        recognizer.cancelsTouchesInView = true
        recognizer.isEnabled = enabled
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UILongPressGestureRecognizer, context: Context) {
        recognizer.isEnabled = enabled
    }

    func handleUIGestureRecognizerAction(_ recognizer: UILongPressGestureRecognizer, context: Context) {
        // Window coordinates remain stable when dismissing the keyboard moves the dock.
        let y = recognizer.location(in: nil).y
        switch recognizer.state {
        case .began:
            context.coordinator.originY = y
            onBegan()
        case .changed:
            onMoved(y - context.coordinator.originY < -65)
        case .ended:
            onMoved(y - context.coordinator.originY < -65)
            onEnded()
        case .cancelled, .failed:
            onCancelled()
        default:
            break
        }
    }

    final class Coordinator {
        var originY: CGFloat = 0
    }
}
