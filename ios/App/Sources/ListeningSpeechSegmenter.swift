import Foundation

/// Audio-sample clock, independent of callback sizes, wall clock and network.
/// Emits only confirmed speech plus bounded context. Silence stays in RAM.
struct ListeningSpeechSegmenter {
    struct Configuration: Sendable {
        var preRoll = 16_000
        var startFrames = 5 // 160 ms at 512 samples / 16 kHz
        var endSilence = 12_800 // 800 ms
        var tail = 8_000 // included in endSilence, not an additional wait
        var maximum = 16_000 * 300
        var overlap = 8_000
    }
    enum Event {
        case begin(sample: Int64, audio: [Float], overlap: Int)
        case append([Float])
        case end(sample: Int64)
    }
    let configuration: Configuration
    private(set) var position: Int64 = 0
    private(set) var isSpeaking = false
    private var recent: [Float] = []
    private var silence: [Float] = []
    private var candidates = 0
    private var start: Int64 = 0
    private var writtenEnd: Int64 = 0
    private var lastEnd: Int64 = 0

    init(configuration: Configuration = .init()) { self.configuration = configuration }

    mutating func consume(_ samples: [Float], probability: Float) -> [Event] {
        precondition(samples.count <= 512 && !samples.isEmpty)
        position += Int64(samples.count)
        recent += samples
        let capacity = configuration.preRoll + configuration.startFrames * 512
        if recent.count > capacity { recent.removeFirst(recent.count - capacity) }
        var events: [Event] = []
        if !isSpeaking {
            candidates = probability >= 0.5 ? candidates + 1 : 0
            guard candidates >= configuration.startFrames else { return [] }
            start = max(lastEnd, position - Int64(recent.count))
            let audio = Array(recent.suffix(Int(position - start)))
            writtenEnd = position
            isSpeaking = true; candidates = 0
            events.append(.begin(sample: start, audio: audio, overlap: 0))
        } else if probability < 0.35 {
            silence += samples
            if silence.count >= configuration.endSilence {
                let tail = Array(silence.prefix(configuration.tail))
                if !tail.isEmpty { events.append(.append(tail)); writtenEnd += Int64(tail.count) }
                events.append(.end(sample: writtenEnd))
                lastEnd = writtenEnd; isSpeaking = false; candidates = 0; silence.removeAll(keepingCapacity: true)
                return events
            }
        } else {
            if !silence.isEmpty { events.append(.append(silence)); silence.removeAll(keepingCapacity: true) }
            events.append(.append(samples)); writtenEnd = position
        }
        // On a long speech, prefer a short pause near the cap. Otherwise preserve
        // 0.5 s context on the next file. Absolute timestamps describe the overlap.
        if isSpeaking && position - start >= Int64(configuration.maximum - configuration.endSilence), silence.count >= 1_600 {
            events += finish()
        } else if isSpeaking && position - start >= Int64(configuration.maximum) {
            if !silence.isEmpty { events.append(.append(silence)); silence.removeAll(keepingCapacity: true); writtenEnd = position }
            events.append(.end(sample: writtenEnd))
            lastEnd = writtenEnd
            let overlap = min(configuration.overlap, recent.count)
            start = position - Int64(overlap)
            events.append(.begin(sample: start, audio: Array(recent.suffix(overlap)), overlap: overlap))
            writtenEnd = position
        }
        return events
    }

    mutating func finish() -> [Event] {
        guard isSpeaking else { candidates = 0; return [] }
        var events: [Event] = []
        let tail = Array(silence.prefix(configuration.tail))
        if !tail.isEmpty { events.append(.append(tail)); writtenEnd += Int64(tail.count) }
        events.append(.end(sample: writtenEnd))
        lastEnd = writtenEnd; isSpeaking = false; candidates = 0; silence.removeAll(keepingCapacity: true)
        return events
    }
}
