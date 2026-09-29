import AVFoundation
import Foundation
import InstantClient
import XCTest
@testable import Instant

final class EchoLocationTests: XCTestCase {
    private let origin = Date(timeIntervalSince1970: 1_700_000_000)
    private func iso(_ seconds: Double) -> String {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: origin.addingTimeInterval(seconds))
    }
    func testTravelFreshnessAndPauseLeaveUnknownIntervals() {
        let history = EchoLocationHistory()
        func add(_ t: Double, _ district: String, _ accuracy: Double = 80) {
            history.add(.init(capturedAt: origin.addingTimeInterval(t), accuracyMeters: accuracy, city: "Shanghai", country: "China", district: district), now: origin.addingTimeInterval(t))
        }
        add(0, "Jing'an"); history.pause(at: origin.addingTimeInterval(10))
        add(15, "Jing'an") // Same place after resumption must not be throttled.
        add(40, "Huangpu"); add(60, "Huangpu", 1500)
        let spans = history.spans(from: origin.addingTimeInterval(5), to: origin.addingTimeInterval(200))
        XCTAssertEqual(spans.map(\.from), [iso(5), iso(15), iso(40), iso(60)])
        XCTAssertEqual(spans.map(\.to), [iso(10), iso(40), iso(60), iso(180)])
        XCTAssertEqual(spans.last?.granularity, "city"); XCTAssertNil(spans.last?.district)
        XCTAssertEqual(EchoLocationContext(spans: spans).displayLabel, "Multiple locations")
    }
    func testSamePlaceNameInDifferentCountriesRemainsMultipleLocations() {
        let spans = ["United Kingdom", "Canada"].map { country in
            EchoLocationSpan(from: iso(0), to: iso(30), capturedAt: iso(0), accuracyMeters: 1000, granularity: "city", city: "London", country: country)
        }
        XCTAssertEqual(EchoLocationContext(spans: spans).displayLabel, "Multiple locations")
    }
    func testInvalidAndStaleFixesNeverBecomeContext() {
        let history = EchoLocationHistory()
        for (age, accuracy, city) in [(121.0, 80.0, "Shanghai"), (-1, 80, "Shanghai"), (0, -1, "Shanghai"), (0, 6000, "Shanghai"), (0, 80, "\n")] {
            history.add(.init(capturedAt: origin.addingTimeInterval(-age), accuracyMeters: accuracy, city: city, country: "China", district: nil), now: origin)
        }
        XCTAssertTrue(history.spans(from: origin, to: origin.addingTimeInterval(30)).isEmpty)
    }
    func testAudioFinalizationSealsLocationAndOfflineRecoveryCannotReplaceIt() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var store = try ListeningStore(scope: "location", root: root)
        let history = EchoLocationHistory(); store.locationHistory = history
        history.add(.init(capturedAt: origin, accuracyMeters: 80, city: "Shanghai", country: "China", district: "Jing'an"), now: origin)
        let writer = ListeningSegmentWriter(store: store, origin: origin)
        try writer.handle(.begin(sample: 0, audio: [Float](repeating: 0.1, count: 16_000), overlap: 0))
        try writer.handle(.end(sample: 16_000))
        let recording = try XCTUnwrap(store.recordings().first)
        XCTAssertEqual(recording.locations?.first?.from, iso(0))
        XCTAssertEqual(recording.locations?.first?.to, iso(1))
        let queue = ListeningBatchStore(store: store), batch = try XCTUnwrap(queue.seal(force: true).first)
        let sealed = try Data(contentsOf: queue.payloadURL(batch.batchId))
        let payload = try JSONSerialization.jsonObject(with: sealed) as! [String: Any]
        let locations = (payload["items"] as! [[String: Any]])[0]["locations"] as! [[String: Any]]
        XCTAssertEqual(locations[0]["city"] as? String, "Shanghai")
        XCTAssertNil(locations[0]["latitude"])
        let reopened = ListeningBatchStore(store: try ListeningStore(scope: "location", root: root))
        XCTAssertTrue(try reopened.seal(force: true).isEmpty)
        XCTAssertEqual(try Data(contentsOf: reopened.payloadURL(batch.batchId)), sealed)
        XCTAssertEqual(try ListeningStore(scope: "location", root: root).recordings().first?.locations, recording.locations)
    }
}
