import Foundation
import XCTest
@testable import Instant

final class EchoMeterTests: XCTestCase {
    func testEnergyFollowsAudioAndSilenceSettlesWithoutUnboundedHistory() {
        func level(_ amplitude: Float) -> UInt8 {
            var meter = EchoAudioMeter()
            for _ in 0..<30 { _ = meter.consume([Float](repeating: amplitude, count: 512), foreground: true) }
            return meter.levels.last!
        }
        XCTAssertEqual(level(0), 0)
        XCTAssertLessThan(level(0.005), level(0.03))
        XCTAssertLessThan(level(0.03), level(0.3))
        var meter = EchoAudioMeter()
        for _ in 0..<100 { _ = meter.consume([Float](repeating: 0.3, count: 512), foreground: true) }
        XCTAssertGreaterThan(meter.levels.max()!, 200)
        for _ in 0..<200 { _ = meter.consume([Float](repeating: 0, count: 512), foreground: true) }
        XCTAssertEqual(meter.levels, [UInt8](repeating: 0, count: 32))
        _ = meter.consume([Float.nan, .infinity, -.infinity], foreground: true)
        XCTAssertEqual(meter.levels.count, 32)
    }

    func testBackgroundPublicationIsBoundedAndForegroundRecoversOnNextColumn() {
        var meter = EchoAudioMeter(), foreground = EchoAudioMeter()
        var backgroundCount = 0, foregroundCount = 0
        for _ in 0..<320 {
            let frame = [Float](repeating: 0.1, count: 512)
            if meter.consume(frame, foreground: false) != nil { backgroundCount += 1 }
            if foreground.consume(frame, foreground: true) != nil { foregroundCount += 1 }
        }
        XCTAssertEqual(backgroundCount, 2, "About 5 seconds between background snapshots")
        XCTAssertEqual(foregroundCount, 106, "96 ms columns; never an update per PCM sample")
        XCTAssertNotNil(meter.consume([Float](repeating: 0, count: 512), foreground: true))
    }

    func testActivityCadencePayloadBudgetAndOldActivityDecoding() throws {
        let now = Date(timeIntervalSince1970: 1000)
        var cadence = EchoActivityMeterCadence()
        XCTAssertTrue(cadence.shouldPublish(at: now))
        for offset in [0.1, 1, 4.999] { XCTAssertFalse(cadence.shouldPublish(at: now.addingTimeInterval(offset))) }
        XCTAssertTrue(cadence.shouldPublish(at: now.addingTimeInterval(5)))
        XCTAssertFalse(cadence.shouldPublish(at: now.addingTimeInterval(19.9), lowPower: true))
        XCTAssertTrue(cadence.shouldPublish(at: now.addingTimeInterval(20), lowPower: true))
        let state = ListeningActivityAttributes.ContentState(isRecording: true, checkedAt: now, timerStartedAt: now,
                                                               waveform: [UInt8](repeating: 255, count: 32), isSpeaking: true)
        let data = try JSONEncoder().encode(state)
        XCTAssertLessThan(data.count, 512, "Leave ample room under ActivityKit's 4 KB budget")
        let old = Data(#"{"isRecording":true,"checkedAt":1000,"timerStartedAt":1000}"#.utf8)
        let decoded = try JSONDecoder().decode(ListeningActivityAttributes.ContentState.self, from: old)
        XCTAssertNil(decoded.waveform); XCTAssertNil(decoded.isSpeaking)
    }
}
