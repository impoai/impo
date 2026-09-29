import AVFoundation
import XCTest
import InstantClient
@testable import Instant

@MainActor
final class ListeningStreamingTests: XCTestCase {
    private let frame = [Float](repeating: 0.25, count: 512)
    func testNoFilesForSilenceOrTransientAndPreRollPreservesOpening() {
        var segmenter = ListeningSpeechSegmenter()
        for _ in 0..<100 { XCTAssertTrue(segmenter.consume(frame, probability: 0.01).isEmpty) }
        for _ in 0..<4 { XCTAssertTrue(segmenter.consume(frame, probability: 0.9).isEmpty) }
        XCTAssertTrue(segmenter.consume(frame, probability: 0.01).isEmpty)
        for _ in 0..<4 { XCTAssertTrue(segmenter.consume(frame, probability: 0.9).isEmpty) }
        let before = segmenter.position
        let events = segmenter.consume(frame, probability: 0.9)
        guard case let .begin(sample, audio, overlap) = events.first else { return XCTFail("Expected speech onset") }
        XCTAssertEqual(sample, before + 512 - 16_000 - 5 * 512)
        XCTAssertEqual(audio.count, 16_000 + 5 * 512)
        XCTAssertEqual(overlap, 0)
        XCTAssertTrue(segmenter.isSpeaking)
    }

    func testShortPauseStaysInsideSegmentAndTailDoesNotAddAnotherWait() {
        var segmenter = ListeningSpeechSegmenter()
        for _ in 0..<5 { _ = segmenter.consume(frame, probability: 0.9) }
        for _ in 0..<12 { XCTAssertTrue(segmenter.consume(frame, probability: 0.1).isEmpty) }
        let resumed = segmenter.consume(frame, probability: 0.6)
        XCTAssertEqual(resumed.count, 2, "Flush the short pause and resume speech")
        let lastSpeech = segmenter.position
        for _ in 0..<24 { XCTAssertTrue(segmenter.consume(frame, probability: 0.1).isEmpty) }
        let events = segmenter.consume(frame, probability: 0.1)
        guard case let .end(sample) = events.last else { return XCTFail("Expected end at 800 ms silence") }
        XCTAssertEqual(sample, lastSpeech + 8_000)
        XCTAssertEqual(segmenter.position, lastSpeech + 12_800)
        XCTAssertFalse(segmenter.isSpeaking)
        XCTAssertTrue(segmenter.finish().isEmpty)
    }

    func testHysteresisAndNextPreRollNeverDuplicateNormalSegments() {
        var segmenter = ListeningSpeechSegmenter()
        for _ in 0..<5 { _ = segmenter.consume(frame, probability: 0.9) }
        for _ in 0..<30 { _ = segmenter.consume(frame, probability: 0.4) }
        XCTAssertTrue(segmenter.isSpeaking)
        var end: Int64 = 0
        for _ in 0..<25 {
            for event in segmenter.consume(frame, probability: 0.1) { if case .end(let sample) = event { end = sample } }
        }
        for _ in 0..<4 { _ = segmenter.consume(frame, probability: 0.9) }
        let events = segmenter.consume(frame, probability: 0.9)
        guard case let .begin(start, _, overlap) = events.first else { return XCTFail("Expected second speech") }
        XCTAssertGreaterThanOrEqual(start, end)
        XCTAssertEqual(overlap, 0)
    }

    func testLongSpeechSplitsWithTimestampedOverlapAndNoMissingSamples() {
        var config = ListeningSpeechSegmenter.Configuration(); config.maximum = 16_000 * 3
        var segmenter = ListeningSpeechSegmenter(configuration: config)
        var starts: [Int64] = []; var ends: [Int64] = []; var lengths: [Int] = []; var overlaps: [Int] = []
        func collect(_ events: [ListeningSpeechSegmenter.Event]) {
            for event in events {
                switch event {
                case let .begin(sample, audio, overlap): starts.append(sample); lengths.append(audio.count); overlaps.append(overlap)
                case let .append(audio): lengths[lengths.count - 1] += audio.count
                case let .end(sample): ends.append(sample)
                }
            }
        }
        for _ in 0..<350 { collect(segmenter.consume(frame, probability: 0.9)) }
        collect(segmenter.finish())
        XCTAssertGreaterThan(starts.count, 2)
        XCTAssertEqual(starts.count, ends.count)
        XCTAssertEqual(ends.last, 350 * 512)
        for index in starts.indices {
            XCTAssertEqual(Int64(lengths[index]), ends[index] - starts[index])
            if index > 0 { XCTAssertEqual(starts[index], ends[index - 1] - 8_000); XCTAssertEqual(overlaps[index], 8_000) }
        }
    }

    func testUploadPolicyOfflineWiFiBatchCellularDelayAndExplicitWiFiOnly() {
        let now = Date(); let old = now.addingTimeInterval(-301)
        XCTAssertFalse(ListeningUploadPolicy.shouldUpload(oldest: old, count: 10, now: now, network: .offline, charging: true, wifiOnly: false))
        XCTAssertFalse(ListeningUploadPolicy.shouldUpload(oldest: now, count: 1, now: now, network: .wifi, charging: false, wifiOnly: false))
        XCTAssertTrue(ListeningUploadPolicy.shouldUpload(oldest: now.addingTimeInterval(-30), count: 1, now: now, network: .wifi, charging: false, wifiOnly: false))
        XCTAssertTrue(ListeningUploadPolicy.shouldUpload(oldest: now.addingTimeInterval(-31), count: 1, now: now, network: .cellular, charging: false, wifiOnly: false))
        XCTAssertTrue(ListeningUploadPolicy.shouldUpload(oldest: old, count: 1, now: now, network: .cellular, charging: false, wifiOnly: false))
        XCTAssertFalse(ListeningUploadPolicy.shouldUpload(oldest: old, count: 20, now: now, network: .cellular, charging: true, wifiOnly: true))
    }

    func testActualStreamingPipelineRejectsSilenceAndWritesSpeechWith48kInput() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try ListeningStore(scope: "streaming-fixture", root: root)
        let silentURL = root.appendingPathComponent("silence.wav")
        try write([Float](repeating: 0, count: 48_000 * 3), rate: 48_000, to: silentURL)
        let silentMeter = MeterSnapshots()
        let silence = ListeningCapture(store: store) { if case .meter(let levels) = $0 { silentMeter.append(levels) } }
        try await silence.replay(silentURL, callbackFrames: 1_000)
        XCTAssertFalse(silentMeter.values.isEmpty)
        XCTAssertTrue(silentMeter.values.allSatisfy { $0.allSatisfy { $0 == 0 } })
        XCTAssertTrue(try store.recordings().isEmpty)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: store.directory.path).isEmpty, "Silence never reaches disk")
        let source = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "speech-zh", withExtension: "wav"))
        let input = try AVAudioFile(forReading: source)
        let buffer = AVAudioPCMBuffer(pcmFormat: input.processingFormat, frameCapacity: AVAudioFrameCount(input.length))!
        try input.read(into: buffer)
        let speech = Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
        // Upsample the fixture; production AVAudioConverter must return it to 16k.
        let padded = [Float](repeating: 0, count: 48_000 * 2) + speech.flatMap { [$0, $0, $0] } + [Float](repeating: 0, count: 48_000 * 2)
        let url = root.appendingPathComponent("speech48.wav"); try write(padded, rate: 48_000, to: url)
        let speechMeter = MeterSnapshots()
        let capture = ListeningCapture(store: store) { if case .meter(let levels) = $0 { speechMeter.append(levels) } }
        try await capture.replay(url, callbackFrames: 997)
        XCTAssertTrue(speechMeter.values.allSatisfy { $0.count == 32 })
        XCTAssertTrue(speechMeter.values.contains { ($0.max() ?? 0) > 100 }, "The real resampled PCM must drive the visible waveform")
        let files = try store.recordings()
        XCTAssertFalse(files.isEmpty)
        for item in files {
            XCTAssertTrue(item.ready); XCTAssertEqual(item.requiresVAD, false); XCTAssertEqual(item.streaming, true)
            let file = try AVAudioFile(forReading: store.audioURL(item.id))
            XCTAssertEqual(file.processingFormat.sampleRate, 16_000)
            XCTAssertEqual(Double(file.length) / 16_000, item.endedAt.timeIntervalSince(item.startedAt), accuracy: 0.15)
            XCTAssertGreaterThan(item.endedAt.timeIntervalSince(item.startedAt), 0.5)
            XCTAssertFalse(FileManager.default.fileExists(atPath: store.rawURL(item.id).path))
        }
        XCTAssertGreaterThan(files.reduce(0) { $0 + $1.endedAt.timeIntervalSince($1.startedAt) }, 6)
        print("Streaming 48k fixture: \(files.map { ($0.startedAt, $0.endedAt) })")
    }

    func testInterruptedSpeechCAFCanRecoverToStableAACQueue() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try ListeningStore(scope: "interrupted", root: root)
        let start = Date(timeIntervalSince1970: 100)
        var item = PendingRecording(id: UUID().uuidString, startedAt: start, endedAt: start, hasSpeech: true, ready: false, requiresVAD: false, streaming: true)
        try store.save(item)
        // Copy the bytes while the writer is still open, approximating an OS
        // termination before AVAudioFile can close/finalize its CAF header.
        let openURL = root.appendingPathComponent("still-open.caf")
        let format = ListeningSegmentWriter.format
        let openFile = try AVAudioFile(forWriting: openURL, settings: format.settings)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 32_000)!
        buffer.frameLength = 32_000
        buffer.floatChannelData![0].initialize(repeating: 0.1, count: 32_000)
        try openFile.write(from: buffer)
        try withExtendedLifetime(openFile) {
            try FileManager.default.copyItem(at: openURL, to: store.rawURL(item.id))
            try ListeningSegmentWriter.finalize(&item, store: store)
        }
        let first = try Data(contentsOf: store.audioURL(item.id))
        XCTAssertTrue(item.ready)
        XCTAssertEqual(item.endedAt, start.addingTimeInterval(2))
        let reopened = try ListeningStore(scope: "interrupted", root: root)
        XCTAssertEqual(try reopened.recordings(), [item])
        XCTAssertEqual(try Data(contentsOf: reopened.audioURL(item.id)), first)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.rawURL(item.id).path))
    }

    func testRealBackgroundBatchRetainsRejectedAudioThenAcceptsFreshCredential() async throws {
        guard let backend = ProcessInfo.processInfo.environment["IMPO_BATCH_QA_BACKEND"] else {
            throw XCTSkip("Requires local batch API/Temporal for system background URLSession")
        }
        let scope = "background-batch-test-" + UUID().uuidString
        let store = try ListeningStore(scope: scope)
        defer { try? FileManager.default.removeItem(at: store.directory) }
        let item = PendingRecording(id: UUID().uuidString.lowercased(), startedAt: Date().addingTimeInterval(-3), endedAt: Date(), hasSpeech: true, ready: true)
        try store.save(item)
        let audio = Data("Background file transfer fixture".utf8)
        try audio.write(to: store.audioURL(item.id))
        let batches = ListeningBatchStore(store:store)
        let batch = try XCTUnwrap(batches.seal(force:true).first)
        let payload = try Data(contentsOf:batches.payloadURL(batch.batchId))
        let badClient = InstantClient(baseURL: URL(string: backend)!, bearerToken: "invalid-token")
        let rejected = try await badClient.listeningBatchUploadRequest()
        do {
            try await ListeningBackgroundUpload.shared.uploadBatch(client:badClient,request:rejected,batch:batch,store:store)
            XCTFail("Invalid credentials must fail")
        } catch {
            XCTAssertEqual(try Data(contentsOf:store.audioURL(item.id)),audio)
            XCTAssertEqual(try Data(contentsOf:batches.payloadURL(batch.batchId)),payload)
        }
        let client = InstantClient(baseURL: URL(string: backend)!, bearerToken: "instant-dev-alice")
        let request = try await client.listeningBatchUploadRequest()
        try await ListeningBackgroundUpload.shared.uploadBatch(client:client,request:request,batch:batch,store:store)
        XCTAssertTrue(try store.recordings().isEmpty)
        XCTAssertTrue(try batches.batches().isEmpty)
        var found: ListeningSegment?
        for _ in 0..<100 {
            found = try await client.listeningHistory(limit:100).segments.first { $0.batchId == batch.batchId && $0.status == "transcribed" }
            if found != nil { break }; try await Task.sleep(for:.milliseconds(100))
        }
        let result = try XCTUnwrap(found)
        XCTAssertEqual(result.segmentCount,1)
        XCTAssertEqual(result.transcript,"Development transcript for \(audio.count) bytes of audio.")
        try await client.deleteListeningSegment(result.id)
        let logs = try await ListeningDiagnostics.shared.read()
        XCTAssertTrue(logs.contains(batch.batchId));XCTAssertTrue(logs.contains("upload.receipt"))
    }

    private func write(_ samples: [Float], rate: Double, to url: URL) throws {
        let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count))!
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        let file = try AVAudioFile(forWriting: url, settings: format.settings)
        try file.write(from: buffer)
    }
}

private final class MeterSnapshots: @unchecked Sendable {
    private let lock = NSLock()
    private var snapshots: [[UInt8]] = []
    func append(_ levels: [UInt8]) { lock.withLock { snapshots.append(levels) } }
    var values: [[UInt8]] { lock.withLock { snapshots } }
}
