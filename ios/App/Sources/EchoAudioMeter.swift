import Foundation
import Observation

/// A tiny display envelope, independent of Silero and the audio saved to disk.
/// Input is the existing mono 16 kHz PCM stream. One column covers 96 ms.
struct EchoAudioMeter {
    private(set) var levels = [UInt8](repeating: 0, count: 32)
    private var squareSum: Double = 0
    private var samples = 0
    private var smoothed: Double = 0
    private var unpublished = 0

    mutating func consume(_ frame: [Float], foreground: Bool) -> [UInt8]? {
        for sample in frame {
            let value = sample.isFinite ? Double(min(1, max(-1, sample))) : 0
            squareSum += value * value
        }
        samples += frame.count
        guard samples >= 1_536 else { return nil }
        let rms = sqrt(squareSum / Double(samples))
        let level = min(1, max(0, (20 * log10(max(rms, 0.000001)) + 60) / 54))
        smoothed += (level - smoothed) * (level > smoothed ? 0.85 : 0.5)
        levels.removeFirst(); levels.append(UInt8((smoothed * 255).rounded()))
        squareSum = 0; samples = 0; unpublished += 1
        // Keep the audio callback and MainActor quiet while the app is locked.
        guard unpublished >= (foreground ? 1 : 53) else { return nil }
        unpublished = 0
        return levels
    }
}

/// Observed only by the small meter view, not by the entire app at audio cadence.
@MainActor @Observable final class EchoMeterPresentation {
    var levels = [UInt8](repeating: 0, count: 32)
    func reset() { levels = [UInt8](repeating: 0, count: 32) }
}

struct EchoActivityMeterCadence {
    private var last = Date.distantPast
    mutating func shouldPublish(at now: Date, lowPower: Bool = false) -> Bool {
        guard now.timeIntervalSince(last) >= (lowPower ? 15 : 5) else { return false }
        last = now
        return true
    }
}
