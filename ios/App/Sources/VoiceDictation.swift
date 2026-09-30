import AVFoundation
import Observation

/// A recorded hold-to-talk clip. Impo transcribes it on the server.
struct VoiceClip: Equatable, Sendable {
    let data: Data
    let mimeType: String
    /// UI tests: the text the server would return for this clip.
    var fixtureTranscript: String?
}

/// Hold-to-talk capture for the chat composer: live microphone level while held, then a
/// compact AAC clip on release. Transcription happens on the Impo server, not on the device.
@MainActor @Observable
final class VoiceDictation {
    enum Phase: Equatable { case idle, starting, recording }
    enum Outcome: Equatable { case clip(VoiceClip), empty, unavailable(String) }

    /// A hold is one message; the server bounds uploads accordingly.
    static let maxDuration: TimeInterval = 120

    private(set) var phase: Phase = .idle
    /// Recent input levels, 0...1, oldest first.
    private(set) var levels: [Double] = Array(repeating: 0, count: 40)

    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var fileURL: URL?
    @ObservationIgnored private var sessionActive = false
    @ObservationIgnored private var meterTask: Task<Void, Never>?
    @ObservationIgnored private var startTask: Task<Outcome?, Never>?
    @ObservationIgnored private var peak: Double = 0
    @ObservationIgnored private var startedAt: Date?
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

    /// Start recording. `finish()` reports permission or microphone failures.
    func begin() {
        guard phase == .idle else { return }
        let token = UUID()
        generation = token
        peak = 0
        levels = Array(repeating: 0, count: levels.count)
        phase = .starting
        startTask = Task { [self] in
            let failure = await start(token)
            if failure != nil, generation == token { teardown() }
            return failure
        }
    }

    /// Stop recording and return the clip.
    func finish() async -> Outcome {
        let token = generation
        let failure = await startTask?.value ?? nil
        guard generation == token else { return .empty }
        startTask = nil
        if let failure { return failure }
        guard phase == .recording else { return .empty }
        if let fixture {
            teardown()
            generation = UUID()
            return .clip(VoiceClip(data: Data(), mimeType: "audio/mp4", fixtureTranscript: fixture))
        }
        // Not `currentTime`: it reads zero once the recorder stops itself at `maxDuration`.
        let duration = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        recorder?.stop()
        let url = fileURL
        let heardSomething = peak >= 0.15
        generation = UUID()
        teardown()
        // A tap or a silent hold is not worth a round trip.
        guard duration >= 0.4, heardSomething, let url, let data = try? Data(contentsOf: url), !data.isEmpty else {
            if let url { try? FileManager.default.removeItem(at: url) }
            return .empty
        }
        try? FileManager.default.removeItem(at: url)
        return .clip(VoiceClip(data: data, mimeType: "audio/mp4"))
    }

    func cancel() {
        generation = UUID()
        startTask?.cancel()
        startTask = nil
        recorder?.stop()
        if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
        teardown()
    }

    private func start(_ token: UUID) async -> Outcome? {
        if fixture != nil {
            phase = .recording
            meterTask = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(120))
                    guard let self, self.generation == token else { return }
                    self.push(Double.random(in: 0.2...0.9))
                }
            }
            return nil
        }
        // A first-time permission prompt interrupts the hold; the next hold records.
        let prompted = AVAudioApplication.shared.recordPermission == .undetermined
        guard await Self.microphoneAllowed() else { return .unavailable("Allow Microphone access in Settings to talk to Impo.") }
        guard generation == token else { return nil }
        if prompted { return .unavailable("You're all set. Hold the input field again to talk.") }

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(token.uuidString).m4a")
        // 16 kHz mono AAC keeps a two-minute hold near 360 KB.
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 24_000,
        ]
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default, options: [.duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            sessionActive = true
            guard session.isInputAvailable else { return .unavailable("No microphone is available.") }
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.isMeteringEnabled = true
            fileURL = url
            self.recorder = recorder
            guard recorder.record(forDuration: Self.maxDuration) else { return .unavailable("Couldn't start the microphone. Try again.") }
        } catch {
            return .unavailable("Couldn't start the microphone. Try again.")
        }
        startedAt = Date()
        phase = .recording
        meterTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
                guard let self, self.generation == token, let recorder = self.recorder else { return }
                recorder.updateMeters()
                // Map roughly -50...-10 dBFS onto 0...1.
                let level = Double((recorder.averagePower(forChannel: 0) + 50) / 40)
                self.peak = max(self.peak, level)
                self.push(level)
            }
        }
        return nil
    }

    private func push(_ level: Double) {
        levels.removeFirst()
        levels.append(max(0, min(1, level)))
    }

    private func teardown() {
        meterTask?.cancel()
        meterTask = nil
        recorder = nil
        fileURL = nil
        startedAt = nil
        if sessionActive {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            sessionActive = false
        }
        phase = .idle
    }

    private static func microphoneAllowed() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
    }
}
