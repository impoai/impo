import SwiftUI

/// A history of microphone energy, drawn as square pixels rather than an FFT.
/// The same renderer is used by the app, Lock Screen and Dynamic Island.
struct EchoWaveform: View {
    var levels: [UInt8]
    var isRecording: Bool
    var isSpeaking: Bool
    var compact = false
    @Environment(\.isLuminanceReduced) private var dimmed

    static let light = Color(red: 0.83, green: 0.88, blue: 0.66)
    static let paper = Color(red: 0.98, green: 0.96, blue: 0.90)

    var body: some View {
        Canvas { context, size in
            let rows = compact ? 5 : 11
            let pitch = size.height / CGFloat(rows)
            let columns = max(1, Int(size.width / pitch))
            let edge = max(1, pitch * 0.67)
            let origin = (size.width - CGFloat(columns) * pitch) / 2
            let samples = levels.isEmpty ? [UInt8](repeating: 0, count: 32) : Array(levels.suffix(32))
            for column in 0..<columns {
                let index = min(samples.count - 1, column * samples.count / columns)
                let level = isRecording ? Double(samples[index]) / 255 : 0
                let halfHeight = level * Double(rows / 2)
                let age = Double(column) / Double(max(1, columns - 1))
                for row in 0..<rows {
                    let distance = abs(Double(row - rows / 2))
                    let lit = isRecording && level > 0.015 && distance <= halfHeight
                    let opacity = lit ? (0.48 + age * 0.52) * (isSpeaking ? 1 : 0.55) : (isRecording ? 0.10 : 0.055)
                    let rect = CGRect(x: origin + CGFloat(column) * pitch + (pitch - edge) / 2,
                                      y: CGFloat(row) * pitch + (pitch - edge) / 2, width: edge, height: edge)
                    context.fill(Path(roundedRect: rect, cornerRadius: min(0.8, edge * 0.15)),
                                 with: .color(Self.light.opacity(opacity * (dimmed ? 0.6 : 1))))
                }
            }
        }
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }
}
