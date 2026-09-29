import AVFoundation
import Foundation
import XCTest
@testable import Instant

@MainActor
final class ListeningVADTests: XCTestCase {
    func testBundledModelRejectsSilenceAndLoudNonSpeech() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let vad = ListeningVAD()
        for (name, samples) in [
            ("silence", [Float](repeating: 0, count: 16_000 * 4)),
            ("hum", (0..<(16_000 * 4)).map { Float(0.1 * sin(2 * .pi * 80 * Double($0) / 16_000)) }),
            ("noise", noise(count: 16_000 * 4)),
        ] {
            let url = root.appendingPathComponent(name + ".wav")
            try write(samples, to: url)
            let result = try await vad.analyze(url: url)
            XCTAssertFalse(result.hasSpeech, "\(name): \(result)")
            XCTAssertEqual(result.analyzedSeconds, 4, accuracy: 0.01)
        }
    }

    func testSpeechSurvivesNoiseAndModelStateResetsBetweenFiles() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let vad = ListeningVAD()
        let fixture = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "speech-en", withExtension: "wav"))
        let clean = try await vad.analyze(url: fixture)
        XCTAssertTrue(clean.hasSpeech)
        let file = try AVAudioFile(forReading: fixture)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
        try file.read(into: buffer)
        let speech = Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
        let background = noise(count: speech.count)
        let speechRMS = sqrt(speech.reduce(0.0) { $0 + Double($1 * $1) } / Double(speech.count))
        let noiseRMS = sqrt(background.reduce(0.0) { $0 + Double($1 * $1) } / Double(background.count))
        // 0 dB SNR controlled smoke test; not a claim about real subway audio.
        let mixed = zip(speech, background).map { max(-1, min(1, $0 + $1 * Float(speechRMS / noiseRMS))) }
        let url = root.appendingPathComponent("mixed.wav")
        try write(mixed, to: url)
        let noisy = try await vad.analyze(url: url)
        XCTAssertTrue(noisy.hasSpeech)
        let silent = root.appendingPathComponent("after-speech.wav")
        try write([Float](repeating: 0, count: 16_000 * 2), to: silent)
        let reset = try await vad.analyze(url: silent)
        XCTAssertFalse(reset.hasSpeech, "Recurrent state must not leak from the previous file")
        print("VAD smoke: clean=\(clean), noisy=\(noisy), reset=\(reset)")
    }

    func testChineseSpeechAndRealMetroMixtureUseTheNativeModel() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let vad = ListeningVAD()
        let speechURL = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "speech-zh", withExtension: "wav"))
        let metroURL = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "metro-30s", withExtension: "wav"))
        func read(_ url: URL) throws -> [Float] {
            let file = try AVAudioFile(forReading: url)
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
            try file.read(into: buffer)
            return Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
        }
        let speech = try read(speechURL)
        let background = Array(try read(metroURL).prefix(speech.count))
        let speechRMS = sqrt(speech.reduce(0.0) { $0 + Double($1 * $1) } / Double(speech.count))
        let noiseRMS = sqrt(background.reduce(0.0) { $0 + Double($1 * $1) } / Double(background.count))
        let clean = try await vad.analyze(url: speechURL)
        XCTAssertTrue(clean.hasSpeech)
        let metro = try await vad.analyze(url: metroURL)
        // This recording may include background speech/announcements. Report the
        // decision, do not falsely label every positive as a detector error.
        print("VAD real metro (unannotated): \(metro)")
        for snr in [10.0, 0.0, -5.0] {
            let scale = Float(speechRMS / (noiseRMS * pow(10, snr / 20)))
            let mixed = zip(speech, background).map { max(-1, min(1, $0 + $1 * scale)) }
            let url = root.appendingPathComponent("metro-\(snr).wav")
            try write(mixed, to: url)
            let result = try await vad.analyze(url: url)
            XCTAssertTrue(result.hasSpeech, "Chinese speech mixed with metro at \(snr) dB")
            print("VAD Chinese + metro \(snr) dB: \(result)")
        }
    }

    func testLocalSilenceIsRemovedWithoutCallingServer() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try ListeningStore(scope: "vad-silence", root: root)
        let item = PendingRecording(id: UUID().uuidString, startedAt: Date().addingTimeInterval(-2),
            endedAt: Date(), hasSpeech: false, ready: true, requiresVAD: true)
        try store.save(item)
        try write([Float](repeating: 0, count: 32_000), to: store.audioURL(item.id), aac: true)
        // With no client sync is skipped; use the existing deterministic failing
        // URL fixture to ensure a would-be upload could not be acknowledged.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [VADHTTPProtocol.self]
        VADHTTPProtocol.requests.reset()
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let model = ListeningModel(storageRoot: root, observeNetwork: false)
        model.configure(scope: "vad-silence", client: .init(baseURL: URL(string: "https://vad.invalid")!, bearerToken: "test", session: session))
        await model.sync()
        XCTAssertTrue(try store.recordings().isEmpty)
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertEqual(VADHTTPProtocol.requests.uploads, 0)
    }

    func testInvalidAudioIsRetainedInsteadOfDiscardedAsSilence() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try ListeningStore(scope: "vad-invalid", root: root)
        let item = PendingRecording(id: UUID().uuidString, startedAt: Date().addingTimeInterval(-2),
            endedAt: Date(), hasSpeech: false, ready: true, requiresVAD: true)
        try store.save(item)
        try Data([1, 2, 3]).write(to: store.audioURL(item.id))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [VADHTTPProtocol.self]
        VADHTTPProtocol.requests.reset()
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let model = ListeningModel(storageRoot: root, observeNetwork: false)
        model.configure(scope: "vad-invalid", client: .init(baseURL: URL(string: "https://vad.invalid")!, bearerToken: "test", session: session))
        await model.sync()
        XCTAssertNotNil(model.uploadError)
        XCTAssertEqual(try store.recordings(), [item])
        XCTAssertEqual(VADHTTPProtocol.requests.uploads, 0)
    }

    func testDetectedSpeechReachesUploadAndDecisionSurvivesRetry() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try ListeningStore(scope: "vad-speech", root: root)
        let fixture = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "speech-en", withExtension: "wav"))
        let input = try AVAudioFile(forReading: fixture)
        let pcm = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: input.processingFormat, frameCapacity: AVAudioFrameCount(input.length)))
        try input.read(into: pcm)
        let samples = Array(UnsafeBufferPointer(start: pcm.floatChannelData![0], count: Int(pcm.frameLength)))
        let item = PendingRecording(id: UUID().uuidString, startedAt: Date().addingTimeInterval(-10),
            endedAt: Date(), hasSpeech: false, ready: true, requiresVAD: true)
        try write(samples, to: store.audioURL(item.id), aac: true)
        try store.save(item)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [VADHTTPProtocol.self]
        VADHTTPProtocol.requests.reset()
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let model = ListeningModel(storageRoot: root, observeNetwork: false)
        model.configure(scope: "vad-speech", client: .init(baseURL: URL(string: "https://vad.invalid")!, bearerToken: "test", session: session))
        await model.sync()
        let processed = try XCTUnwrap(store.recordings().first)
        XCTAssertTrue(processed.speechAnalysis?.hasSpeech == true)
        XCTAssertEqual(VADHTTPProtocol.requests.uploads, 1)
        XCTAssertNotNil(model.uploadError)
        await model.sync()
        XCTAssertEqual(VADHTTPProtocol.requests.uploads, 2)
        XCTAssertEqual(try store.recordings(), [processed], "Retry keeps the same UUID and cached inference decision")
    }

    private func temporaryDirectory() -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func noise(count: Int) -> [Float] {
        var state: UInt64 = 42
        return (0..<count).map { _ in
            state = state &* 6364136223846793005 &+ 1
            return (Float(state >> 40) / Float(1 << 24) * 2 - 1) * 0.1
        }
    }

    private func write(_ samples: [Float], to url: URL, aac: Bool = false) throws {
        let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count))!
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        let settings: [String: Any] = aac
            ? [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 24_000]
            : format.settings
        let file = try AVAudioFile(forWriting: url, settings: settings)
        try file.write(from: buffer)
    }
}

private final class VADHTTPProtocol: URLProtocol, @unchecked Sendable {
    final class Requests: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var uploads: Int { lock.withLock { count } }
        func reset() { lock.withLock { count = 0 } }
        func upload() { lock.withLock { count += 1 } }
    }
    static let requests = Requests()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.httpMethod == "POST" { Self.requests.upload() }
        let response = HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
