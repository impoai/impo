import AVFoundation
import Observation
import Speech

/// Hold-to-talk dictation for the chat composer: live microphone level and partial text while
/// held, then the final transcript on release. Audio stays on the device; Apple's speech
/// service may process it when on-device recognition is unavailable for the language.
@MainActor @Observable
final class VoiceDictation {
    enum Phase: Equatable { case idle, starting, recording, transcribing }
    enum Outcome: Equatable { case text(String), empty, unavailable(String) }

    private(set) var phase: Phase = .idle
    private(set) var transcript = ""
    /// Recent input levels, 0...1, oldest first.
    private(set) var levels: [Double] = Array(repeating: 0, count: 40)

    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var tapInstalled = false
    @ObservationIgnored private var sessionActive = false
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private var startTask: Task<Outcome?, Never>?
    @ObservationIgnored private var finalContinuation: CheckedContinuation<Void, Never>?
    @ObservationIgnored private var finalReceived = false
    @ObservationIgnored private var generation = UUID()
    /// UI tests: no microphone, a fixed transcript.
    @ObservationIgnored private let fixture: String?

    init(fixture: String? = ProcessInfo.processInfo.arguments.firstIndex(of: "--voice-fixture").flatMap { index in
        let arguments = ProcessInfo.processInfo.arguments
        return arguments.indices.contains(index + 1) ? arguments[index + 1] : nil
    }) {
        self.fixture = fixture
    }

    var isActive: Bool { phase == .starting || phase == .recording }

    /// Start listening. Returns a failure outcome when permissions or the recognizer are unavailable.
    func begin() {
        guard phase == .idle else { return }
        let token = UUID()
        generation = token
        transcript = ""
        finalReceived = false
        levels = Array(repeating: 0, count: levels.count)
        phase = .starting
        startTask = Task { [self] in
            let failure = await start(token)
            if failure != nil, generation == token { teardown() }
            return failure
        }
    }

    /// Stop listening and return the final transcript. `phase` is `.transcribing` meanwhile.
    func finish() async -> Outcome {
        let token = generation
        let failure = await startTask?.value ?? nil
        guard generation == token else { return .empty }
        startTask = nil
        if let failure { return failure }
        guard generation == token, phase == .recording else { return .empty }
        phase = .transcribing
        if let fixture {
            try? await Task.sleep(for: .seconds(2))
            guard generation == token, !Task.isCancelled else { return .empty }
            transcript = fixture
        } else {
            stopAudio()
            request?.endAudio()
            // The final result usually arrives well under a second after the audio ends.
            if !finalReceived {
                await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                    finalContinuation = continuation
                    Task { @MainActor [weak self] in
                        try? await Task.sleep(for: .seconds(3))
                        guard self?.generation == token else { return }
                        self?.resumeFinal()
                    }
                }
            }
        }
        guard generation == token, !Task.isCancelled else { return .empty }
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        generation = UUID()
        teardown()
        return text.isEmpty ? .empty : .text(text)
    }

    func cancel() {
        generation = UUID()
        startTask?.cancel()
        startTask = nil
        teardown()
    }

    private func start(_ token: UUID) async -> Outcome? {
        if let fixture {
            phase = .recording
            for (index, word) in fixture.split(separator: " ").enumerated() {
                try? await Task.sleep(for: .milliseconds(120))
                guard generation == token else { return nil }
                transcript = fixture.split(separator: " ").prefix(index + 1).joined(separator: " ")
                push(Double.random(in: 0.2...0.9))
                _ = word
            }
            return nil
        }
        // A first-time permission prompt interrupts the hold; the next hold records.
        let prompted = AVAudioApplication.shared.recordPermission == .undetermined || SFSpeechRecognizer.authorizationStatus() == .notDetermined
        guard await Self.microphoneAllowed() else { return .unavailable("Allow Microphone access in Settings to talk to Impo.") }
        guard generation == token else { return nil }
        guard await Self.speechAllowed() else { return .unavailable("Allow Speech Recognition in Settings to talk to Impo.") }
        guard generation == token else { return nil }
        if prompted { return .unavailable("You're all set. Hold the input field again to talk.") }
        guard let recognizer = Self.recognizer(), recognizer.isAvailable else { return .unavailable("Speech recognition isn't available right now. Try typing instead.") }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        let engine = AVAudioEngine()
        self.engine = engine
        self.request = request
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            sessionActive = true
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { return .unavailable("No microphone is available.") }
            input.installTap(onBus: 0, bufferSize: 1024, format: format,
                             block: Self.audioTap(request: request) { [weak self] level in
                guard let self, self.generation == token, self.phase == .recording else { return }
                self.push(level)
            })
            tapInstalled = true
            engine.prepare()
            try engine.start()
        } catch {
            return .unavailable("Couldn't start the microphone. Try again.")
        }
        task = recognizer.recognitionTask(with: request, resultHandler: Self.recognitionHandler { [weak self] text, done in
            guard let self, self.generation == token else { return }
            if let text { self.transcript = text }
            if done { self.finalReceived = true; self.resumeFinal() }
        })
        phase = .recording
        return nil
    }

    // AVFoundation and Speech invoke these Objective-C callbacks on their own queues.
    // Construct them outside MainActor so Swift 6 doesn't insert a main-executor
    // assertion before the explicit hop that updates observable UI state.
    nonisolated static func audioTap(request: SFSpeechAudioBufferRecognitionRequest,
                                    onLevel: @escaping @MainActor @Sendable (Double) -> Void) -> AVAudioNodeTapBlock {
        { buffer, _ in
            request.append(buffer)
            let level = Self.level(buffer)
            Task { @MainActor in onLevel(level) }
        }
    }

    nonisolated static func recognitionHandler(
        onResult: @escaping @MainActor @Sendable (String?, Bool) -> Void
    ) -> (SFSpeechRecognitionResult?, Error?) -> Void {
        { result, error in
            let text = result?.bestTranscription.formattedString
            let done = result?.isFinal == true || error != nil
            Task { @MainActor in onResult(text, done) }
        }
    }

    private func push(_ level: Double) {
        levels.removeFirst()
        levels.append(max(0, min(1, level)))
    }

    private func resumeFinal() {
        finalContinuation?.resume()
        finalContinuation = nil
    }

    private func teardown() {
        stopAudio()
        resumeFinal()
        task?.cancel()
        task = nil
        request = nil
        engine = nil
        phase = .idle
    }

    private func stopAudio() {
        engine?.stop()
        if let engine, tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        if sessionActive {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            sessionActive = false
        }
    }

    /// Prefer the user's first language so Chinese and English speakers both get their own model.
    private static func recognizer() -> SFSpeechRecognizer? {
        for identifier in Locale.preferredLanguages {
            if let recognizer = SFSpeechRecognizer(locale: Locale(identifier: identifier)) { return recognizer }
        }
        return SFSpeechRecognizer()
    }

    private static func microphoneAllowed() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
    }

    private static func speechAllowed() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { @Sendable status in
                    continuation.resume(returning: status == .authorized)
                }
            }
        default: return false
        }
    }

    nonisolated private static func level(_ buffer: AVAudioPCMBuffer) -> Double {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var sum: Float = 0
        for index in 0..<Int(buffer.frameLength) { sum += samples[index] * samples[index] }
        let rms = sqrt(sum / Float(buffer.frameLength))
        // Map roughly -50...-10 dBFS onto 0...1.
        let decibels = 20 * log10(max(rms, 0.000_01))
        return Double((decibels + 50) / 40)
    }
}
