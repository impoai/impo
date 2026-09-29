import AVFoundation
import Foundation

enum ListeningCaptureError: Error { case invalidRoute, overloaded, storageFull, conversion }

protocol ListeningCaptureSession: Sendable {
    var isReceivingAudio: Bool { get }
    func start() async throws
    func stop(deactivateSession: Bool) async -> String?
    func setMeterForeground(_ foreground: Bool)
}

extension ListeningCaptureSession { func setMeterForeground(_ foreground: Bool) {} }

/// AVAudioEngine owns the mic; one serial queue owns conversion, recurrent VAD
/// state and segment files. The audio callback only copies into a bounded queue.
final class ListeningCapture: ListeningCaptureSession, @unchecked Sendable {
    enum Update: Sendable { case speech(Bool), meter([UInt8]), saved, interrupted, failed(String) }
    private let queue = DispatchQueue(label: "ai.impo.listening.capture", qos: .userInitiated)
    private let gate = NSLock()
    private let packets = DispatchGroup()
    private var accepting = false
    private var pendingBuffers = 0
    private var lastAudioAt = Date()
    private var overflowReported = false
    private let store: ListeningStore
    private let update: @Sendable (Update) -> Void
    // Accessed only on queue, including engine start/stop.
    private var engine: AVAudioEngine?
    private var tapInstalled = false
    private var configurationObserver: NSObjectProtocol?
    private var converter: AVAudioConverter?
    private var vad: SileroEngine?
    private var writer: ListeningSegmentWriter?
    private var segmenter = ListeningSpeechSegmenter()
    private var remainder: [Float] = []
    private var expectedInputSample: AVAudioFramePosition?
    private var failed = false
    private var meter = EchoAudioMeter()
    private var meterForeground = true

    init(store: ListeningStore, update: @escaping @Sendable (Update) -> Void) { self.store = store; self.update = update }

    func setMeterForeground(_ foreground: Bool) { queue.async { self.meterForeground = foreground } }

    var isReceivingAudio: Bool { gate.withLock { accepting && Date().timeIntervalSince(lastAudioAt) < 8 } }

    func start() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async { [self] in
                do {
                    let session = AVAudioSession.sharedInstance()
                    // Keep other apps' music playing, including stereo Bluetooth
                    // output. Do not request HFP/the headset mic or duck music.
                    try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .mixWithOthers, .allowBluetoothA2DP])
                    try session.setPreferredSampleRate(16_000)
                    try session.setPreferredIOBufferDuration(0.032)
                    try session.setActive(true)
                    let engine = AVAudioEngine()
                    self.engine = engine
                    let format = engine.inputNode.outputFormat(forBus: 0)
                    guard format.sampleRate > 0, format.channelCount > 0,
                          let converter = AVAudioConverter(from: format, to: ListeningSegmentWriter.format) else { throw ListeningCaptureError.invalidRoute }
                    self.converter = converter
                    vad = try SileroEngine()
                    gate.withLock { accepting = true; lastAudioAt = Date() }
                    engine.inputNode.installTap(onBus: 0, bufferSize: 1_024, format: format) { [weak self] buffer, time in
                        self?.receive(buffer, time: time)
                    }
                    tapInstalled = true
                    engine.prepare()
                    try engine.start()
                    configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
                        // Apple's callback runs on an internal audio queue. Never
                        // tear the engine down synchronously from this callback.
                        self?.queue.async { [weak self] in self?.inputConfigurationChanged() }
                    }
                    continuation.resume()
                } catch {
                    gate.withLock { accepting = false }
                    if let engine {
                        if tapInstalled { engine.inputNode.removeTap(onBus: 0) }
                        engine.stop()
                    }
                    tapInstalled = false
                    engine = nil
                    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func receive(_ buffer: AVAudioPCMBuffer, time: AVAudioTime) {
        let allowed = gate.withLock { () -> Bool in
            guard accepting else { return false }
            lastAudioAt = Date()
            guard pendingBuffers < 128 else {
                accepting = false
                if !overflowReported {
                    overflowReported = true
                    queue.async { [weak self] in self?.fail("Echo couldn't keep up with the microphone. Saved speech is kept; tap Echo to restart.") }
                }
                return false
            }
            pendingBuffers += 1; packets.enter(); return true
        }
        guard allowed else { return }
        guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else {
            gate.withLock { pendingBuffers -= 1 }; packets.leave()
            queue.async { [weak self] in self?.fail("Couldn't buffer microphone audio. Tap Echo to restart.") }
            return
        }
        copy.frameLength = buffer.frameLength
        let source = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: buffer.audioBufferList))
        let target = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for index in 0..<source.count {
            guard let from = source[index].mData, let to = target[index].mData else { continue }
            memcpy(to, from, Int(source[index].mDataByteSize))
        }
        let packet = AudioPacket(buffer: copy, sample: time.isSampleTimeValid ? time.sampleTime : nil, date: Date())
        queue.async { [self] in
            defer { gate.withLock { pendingBuffers -= 1 }; packets.leave() }
            guard !failed else { return }
            do { try process(packet) }
            catch ListeningCaptureError.invalidRoute {
                failed = true; gate.withLock { accepting = false }
                update(.interrupted) // Close the file at the gap; a new capture gets a new clock origin.
            }
            catch { fail(error is ListeningCaptureError ? "Couldn't continue recording. Check iPhone storage and tap Echo to restart." : "Audio processing stopped. Saved speech is kept; tap Echo to restart.") }
        }
    }

    private func process(_ packet: AudioPacket) throws {
        guard let converter, let vad else { return }
        if let sample = packet.sample {
            if let expectedInputSample, sample != expectedInputSample {
                throw ListeningCaptureError.invalidRoute // never silently stitch over lost audio
            }
            expectedInputSample = sample + AVAudioFramePosition(packet.buffer.frameLength)
        }
        if writer == nil { writer = ListeningSegmentWriter(store: store, origin: packet.date.addingTimeInterval(-Double(packet.buffer.frameLength) / packet.buffer.format.sampleRate)) }
        let capacity = AVAudioFrameCount(ceil(Double(packet.buffer.frameLength) * 16_000 / packet.buffer.format.sampleRate)) + 32
        let output = AVAudioPCMBuffer(pcmFormat: ListeningSegmentWriter.format, frameCapacity: capacity)!
        var supplied = false
        while true {
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, inputStatus in
                if supplied { inputStatus.pointee = .noDataNow; return nil }
                supplied = true; inputStatus.pointee = .haveData; return packet.buffer
            }
            if let error { throw error }
            guard status != .error else { throw ListeningCaptureError.conversion }
            if output.frameLength > 0 {
                remainder += Array(UnsafeBufferPointer(start: output.floatChannelData![0], count: Int(output.frameLength)))
                while remainder.count >= 512 {
                    let frame = Array(remainder.prefix(512)); remainder.removeFirst(512)
                    let probability = try frame.withUnsafeBufferPointer { try vad.predict(samples: $0.baseAddress!, count: 512) }
                    let wasSpeaking = segmenter.isSpeaking
                    let count = writer?.completed ?? 0
                    for event in segmenter.consume(frame, probability: probability) { try writer?.handle(event) }
                    if count != writer?.completed { update(.saved) }
                    if wasSpeaking != segmenter.isSpeaking { update(.speech(segmenter.isSpeaking)) }
                    if let levels = meter.consume(frame, foreground: meterForeground) { update(.meter(levels)) }
                }
            }
            if status == .inputRanDry || status == .endOfStream || output.frameLength == 0 { break }
        }
    }

    private func inputConfigurationChanged() {
        guard !failed, gate.withLock({ accepting }) else { return }
        failed = true; gate.withLock { accepting = false }
        update(.interrupted)
    }

    #if DEBUG
    /// Replays fixtures through the same native converter, recurrent model,
    /// segmenter and file writer without opening a microphone.
    func replay(_ url: URL, callbackFrames: AVAudioFrameCount = 1_024) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async { [self] in
                do {
                    let file = try AVAudioFile(forReading: url)
                    converter = AVAudioConverter(from: file.processingFormat, to: ListeningSegmentWriter.format)
                    vad = try SileroEngine()
                    let origin = Date(timeIntervalSince1970: 1_800_000_000)
                    while file.framePosition < file.length {
                        let sample = file.framePosition
                        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: callbackFrames)!
                        try file.read(into: buffer, frameCount: AVAudioFrameCount(min(Int64(callbackFrames), file.length - file.framePosition)))
                        guard buffer.frameLength > 0 else { throw ListeningVADError.invalidAudio }
                        try process(AudioPacket(buffer: buffer, sample: sample,
                            date: origin.addingTimeInterval(Double(sample + Int64(buffer.frameLength)) / file.processingFormat.sampleRate)))
                    }
                    if !remainder.isEmpty, let vad {
                        let probability = try remainder.withUnsafeBufferPointer { try vad.predict(samples: $0.baseAddress!, count: remainder.count) }
                        for event in segmenter.consume(remainder, probability: probability) { try writer?.handle(event) }
                        remainder.removeAll()
                    }
                    for event in segmenter.finish() { try writer?.handle(event) }
                    writer = nil
                    continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    #endif

    private func fail(_ message: String) {
        guard !failed else { return }
        failed = true; gate.withLock { accepting = false }
        update(.failed(message))
    }

    /// Drains already accepted audio before closing the last utterance. Completion
    /// belongs to this capture/store even if the user has switched accounts.
    func stop(deactivateSession: Bool = true) async -> String? {
        gate.withLock { accepting = false }
        return await withCheckedContinuation { continuation in
            packets.notify(queue: queue) { [self] in
                if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
                configurationObserver = nil
                if let engine {
                    if tapInstalled { engine.inputNode.removeTap(onBus: 0) }
                    engine.stop()
                }
                tapInstalled = false
                engine = nil
                var failure: String?
                do {
                    if !remainder.isEmpty, let vad {
                        let probability = try remainder.withUnsafeBufferPointer { try vad.predict(samples: $0.baseAddress!, count: remainder.count) }
                        for event in segmenter.consume(remainder, probability: probability) { try writer?.handle(event) }
                    }
                    for event in segmenter.finish() { try writer?.handle(event) }
                    update(.saved)
                } catch { failure = "Couldn't finish the recording. Saved audio remains on this iPhone for recovery." }
                writer = nil; converter = nil; vad = nil; remainder.removeAll()
                // A system interruption already deactivated us. Keep the system's
                // interruption/resumption lifecycle intact while finalizing audio.
                if deactivateSession { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
                continuation.resume(returning: failure)
            }
        }
    }
}

private struct AudioPacket: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
    let sample: AVAudioFramePosition?
    let date: Date
}
