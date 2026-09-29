import AVFoundation
import SwiftUI

@main struct Probe: App {
    @State private var audio = Audio()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 30) {
                Text(audio.state).accessibilityIdentifier("probe.state")
                Button("Start microphone") { Task { await audio.start() } }.accessibilityIdentifier("probe.start")
                Button("Release microphone") { audio.stop() }.accessibilityIdentifier("probe.stop")
                Button("Play test music") { audio.playMusic() }.accessibilityIdentifier("probe.music")
            }
            .onChange(of: scenePhase) { _, phase in if phase == .active { audio.refreshMusicStatus() } }
        }
    }
}
@MainActor @Observable final class Audio {
    var state = "Idle"
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayer?
    func start() async {
        guard await AVAudioApplication.requestRecordPermission() else { state = "Permission denied"; return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try session.setActive(true)
            let engine = AVAudioEngine()
            let input = engine.inputNode
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { @Sendable _, _ in }
            engine.prepare(); try engine.start()
            self.engine = engine; state = "Microphone occupied"
        } catch { state = "Failed: \(error)" }
    }
    func stop() {
        player?.stop(); player = nil
        engine?.inputNode.removeTap(onBus: 0); engine?.stop(); engine = nil
        do { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation); state = "Microphone released" }
        catch { state = "Failed: \(error)" }
    }

    func playMusic() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default) // Deliberately non-mixing, like a music app.
            try session.setActive(true)
            let player = try AVAudioPlayer(data: Self.tone(), fileTypeHint: AVFileType.wav.rawValue)
            player.numberOfLoops = -1
            player.volume = 0 // Exercise a real playback session without audible test noise.
            guard player.play() else { state = "Music failed"; return }
            self.player = player; state = "Music playing"
        } catch { state = "Failed: \(error)" }
    }

    func refreshMusicStatus() {
        if let player { state = player.isPlaying ? "Music playing" : "Music interrupted" }
    }

    private static func tone() -> Data {
        var samples = Data()
        for i in 0..<48_000 {
            var value = Int16(sin(Double(i) * 2 * .pi * 440 / 48_000) * 500).littleEndian
            withUnsafeBytes(of: &value) { samples.append(contentsOf: $0) }
        }
        var data = Data("RIFF".utf8)
        func u32(_ value: UInt32) { var little = value.littleEndian; withUnsafeBytes(of: &little) { data.append(contentsOf: $0) } }
        func u16(_ value: UInt16) { var little = value.littleEndian; withUnsafeBytes(of: &little) { data.append(contentsOf: $0) } }
        u32(UInt32(36 + samples.count)); data.append(Data("WAVEfmt ".utf8))
        u32(16); u16(1); u16(1); u32(48_000); u32(96_000); u16(2); u16(16)
        data.append(Data("data".utf8)); u32(UInt32(samples.count)); data.append(samples)
        return data
    }
}
