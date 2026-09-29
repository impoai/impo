import AVFoundation
import Foundation
import OnnxRuntimeBindings

/// Persist only detection statistics, never PCM samples or model tensors.
struct ListeningSpeechAnalysis: Codable, Equatable, Sendable {
    var version: String
    var hasSpeech: Bool
    var analyzedSeconds: Double
    var speechSeconds: Double
    var processingSeconds: Double
}

/// A single off-main actor owns the native ONNX/C++ session. No audio leaves
/// the device during this step. State/context are reset for every file so a
/// previous account or recording cannot affect the next decision.
actor ListeningVAD {
    static let version = "silero-6.2.3-gate-1"
    private var engine: SileroEngine?

    func analyze(url: URL) throws -> ListeningSpeechAnalysis {
        try Task.checkCancellation()
        let started = Date()
        let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
        // The recorder produces mono 16 kHz AAC. Reject unexpected/corrupt
        // formats instead of classifying an incorrectly sampled file as silence.
        guard file.processingFormat.sampleRate == 16_000,
              file.processingFormat.channelCount == 1,
              file.length > 0, file.length <= 16_000 * 600 else {
            throw ListeningVADError.invalidAudio
        }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 512) else {
            throw ListeningVADError.invalidAudio
        }
        if engine == nil { engine = try SileroEngine() }
        guard let engine else { throw ListeningVADError.missingModel }
        engine.reset()
        var gate = ListeningSpeechGate()
        var count = 0
        while file.framePosition < file.length {
            try Task.checkCancellation()
            // Reads may return less than the requested capacity; continue to
            // EOF rather than treating the first short read as the whole file.
            try file.read(into: buffer, frameCount: AVAudioFrameCount(min(512, file.length - file.framePosition)))
            let frames = Int(buffer.frameLength)
            guard frames > 0 else { throw ListeningVADError.invalidAudio }
            guard let samples = buffer.floatChannelData?[0] else { throw ListeningVADError.invalidAudio }
            count += frames
            guard count <= 16_000 * 600 else { throw ListeningVADError.invalidAudio }
            let probability = try engine.predict(samples: samples, count: frames)
            gate.sample(probability: probability, frames: frames)
        }
        guard count > 0 else { throw ListeningVADError.invalidAudio }
        return ListeningSpeechAnalysis(version: Self.version, hasSpeech: gate.hasSpeech,
            analyzedSeconds: Double(count) / 16_000, speechSeconds: Double(gate.speechFrames) / 16_000,
            processingSeconds: Date().timeIntervalSince(started))
    }
}

/// Conservative whole-file gate: 96 ms of consecutive speech probability >=0.5.
/// A short transient cannot trigger it. Once accepted, the entire file is kept
/// to preserve quiet words, phrase boundaries and pauses. This is not denoising.
struct ListeningSpeechGate {
    private(set) var hasSpeech = false
    private(set) var speechFrames = 0
    private var consecutiveFrames = 0

    mutating func sample(probability: Float, frames: Int) {
        guard probability.isFinite, probability >= 0.5 else { consecutiveFrames = 0; return }
        speechFrames += frames
        consecutiveFrames += frames
        if consecutiveFrames >= 1_536 { hasSpeech = true }
    }
}

enum ListeningVADError: Error {
    case missingModel, invalidAudio, invalidPrediction
}

/// Silero's official ONNX input contract: 512 new 16 kHz samples plus 64
/// context samples, recurrent state [2,1,128], and an int64 sample rate.
/// Microsoft provides the Objective-C bridge to its C++ inference runtime.
final class SileroEngine {
    private let environment: ORTEnv
    private let session: ORTSession
    private var state = [Float](repeating: 0, count: 256)
    private var context = [Float](repeating: 0, count: 64)

    init() throws {
        guard let model = Bundle.main.url(forResource: "silero_vad", withExtension: "onnx") else { throw ListeningVADError.missingModel }
        environment = try ORTEnv(loggingLevel: .error)
        let options = try ORTSessionOptions()
        try options.setIntraOpNumThreads(1)
        try options.setGraphOptimizationLevel(.all)
        try options.addConfigEntry(withKey: "session.intra_op.allow_spinning", value: "0")
        session = try ORTSession(env: environment, modelPath: model.path, sessionOptions: options)
    }

    func reset() {
        state = [Float](repeating: 0, count: 256)
        context = [Float](repeating: 0, count: 64)
    }

    func predict(samples: UnsafePointer<Float>, count: Int) throws -> Float {
        var input = context + Array(UnsafeBufferPointer(start: samples, count: count))
        input += [Float](repeating: 0, count: 512 - count)
        let inputTensor = try tensor(input, shape: [1, 576])
        let stateTensor = try tensor(state, shape: [2, 1, 128])
        var rate: Int64 = 16_000
        let rateData = NSMutableData(bytes: &rate, length: MemoryLayout<Int64>.size)
        let rateTensor = try ORTValue(tensorData: rateData, elementType: .int64, shape: [1])
        let outputs = try session.run(withInputs: ["input": inputTensor, "state": stateTensor, "sr": rateTensor],
                                      outputNames: ["output", "stateN"], runOptions: nil)
        guard let output = outputs["output"], let nextState = outputs["stateN"] else { throw ListeningVADError.invalidPrediction }
        // Copy before ORTValue releases the memory it owns.
        let probabilityData = try output.tensorData() as Data
        let stateData = try nextState.tensorData() as Data
        guard probabilityData.count == 4, stateData.count == 256 * 4 else { throw ListeningVADError.invalidPrediction }
        let probability = probabilityData.withUnsafeBytes { $0.loadUnaligned(as: Float.self) }
        guard probability.isFinite, (0...1).contains(probability) else { throw ListeningVADError.invalidPrediction }
        state = stateData.withUnsafeBytes { bytes in (0..<256).map { bytes.loadUnaligned(fromByteOffset: $0 * 4, as: Float.self) } }
        context = Array(input.suffix(64))
        return probability
    }

    private func tensor(_ samples: [Float], shape: [NSNumber]) throws -> ORTValue {
        let data = samples.withUnsafeBytes { NSMutableData(bytes: $0.baseAddress!, length: $0.count) }
        return try ORTValue(tensorData: data, elementType: .float, shape: shape)
    }
}
