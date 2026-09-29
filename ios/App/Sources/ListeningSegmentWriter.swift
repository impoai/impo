import AVFoundation
import Foundation

/// Owned exclusively by the capture queue. Crash-recoverable PCM while speaking;
/// atomically finalized AAC before the uploader can see a ready recording.
final class ListeningSegmentWriter {
    static let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
    let store: ListeningStore
    let origin: Date
    private var item: PendingRecording?
    private var file: AVAudioFile?
    private var lastCheckpoint: Int64 = 0
    private(set) var completed = 0
    init(store: ListeningStore, origin: Date) { self.store = store; self.origin = origin }

    func handle(_ event: ListeningSpeechSegmenter.Event) throws {
        switch event {
        case let .begin(sample, audio, overlap):
            let files = try store.recordings()
            // The queue is bounded by bytes as well as count; never discard speech
            // to make room. Stop visibly and let the user sync existing recordings.
            let bytes = try store.storageBytes()
            guard files.count < 2_880, bytes < 256 * 1_024 * 1_024 else { throw ListeningCaptureError.storageFull }
            let date = origin.addingTimeInterval(Double(sample) / 16_000)
            let next = PendingRecording(id: UUID().uuidString.lowercased(), startedAt: date, endedAt: date,
                hasSpeech: true, ready: false, requiresVAD: false, overlapSeconds: Double(overlap) / 16_000, streaming: true, listeningSessionId: store.sessionId)
            ListeningDiagnostics.shared.record("segment.started", ["segmentId":next.id,"sessionId":store.sessionId ?? "legacy"])
            try store.save(next); item = next; lastCheckpoint = 0
            file = try AVAudioFile(forWriting: store.rawURL(next.id), settings: Self.format.settings)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: store.rawURL(next.id).path)
            try append(audio)
        case let .append(audio): try append(audio)
        case let .end(sample):
            guard var next = item else { return }
            file = nil // close/update CAF before conversion
            next.endedAt = origin.addingTimeInterval(Double(sample) / 16_000)
            next.locations = store.locationHistory?.spans(from: next.startedAt, to: next.endedAt)
            if next.endedAt.timeIntervalSince(next.startedAt) <= (next.overlapSeconds ?? 0) {
                try store.remove(next.id); item = nil; return
            }
            try store.save(next)
            try Self.finalize(&next, store: store)
            item = nil; completed += 1
        }
    }

    private func append(_ audio: [Float]) throws {
        guard let file, var next = item, !audio.isEmpty else { return }
        let buffer = AVAudioPCMBuffer(pcmFormat: Self.format, frameCapacity: AVAudioFrameCount(audio.count))!
        buffer.frameLength = AVAudioFrameCount(audio.count)
        audio.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: audio.count) }
        try file.write(from: buffer)
        if file.framePosition - lastCheckpoint >= 16_000 * 5 {
            next.endedAt = next.startedAt.addingTimeInterval(Double(file.framePosition) / 16_000)
            next.locations = store.locationHistory?.spans(from: next.startedAt, to: next.endedAt)
            ListeningDiagnostics.shared.record("segment.started", ["segmentId":next.id,"sessionId":store.sessionId ?? "legacy"])
            try store.save(next); item = next; lastCheckpoint = file.framePosition
        }
    }

    static func finalize(_ item: inout PendingRecording, store: ListeningStore) throws {
        let input = try AVAudioFile(forReading: store.rawURL(item.id))
        guard input.length > 0, input.length <= 16_000 * 301 else { throw ListeningVADError.invalidAudio }
        // Re-encode only a not-yet-uploadable file. Once ready, retries reuse exact bytes.
        let destination = store.encodingURL(item.id)
        try? FileManager.default.removeItem(at: destination)
        var output: AVAudioFile? = try AVAudioFile(forWriting: destination, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 24_000,
        ])
        let buffer = AVAudioPCMBuffer(pcmFormat: input.processingFormat, frameCapacity: 4_096)!
        while input.framePosition < input.length {
            try input.read(into: buffer, frameCount: AVAudioFrameCount(min(4_096, input.length - input.framePosition)))
            guard buffer.frameLength > 0 else { throw ListeningVADError.invalidAudio }
            try output?.write(from: buffer)
        }
        output = nil
        let target = store.audioURL(item.id)
        if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
        try FileManager.default.moveItem(at: destination, to: target)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: target.path)
        item.endedAt = item.startedAt.addingTimeInterval(Double(input.length) / 16_000)
        if let history = store.locationHistory { item.locations = history.spans(from: item.startedAt, to: item.endedAt) }
        item.ready = true
        try store.save(item)
        ListeningDiagnostics.shared.record("segment.saved", ["segmentId":item.id,"seconds":"\(item.endedAt.timeIntervalSince(item.startedAt))","bytes":"\((try? Data(contentsOf: target).count) ?? 0)"])
        try? FileManager.default.removeItem(at: store.rawURL(item.id))
    }
}
