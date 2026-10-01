import Foundation
import XCTest
@testable import InstantClient

final class AppReleaseTests: XCTestCase {
    private func data(_ changes: [String: Any] = [:], envelope: [String: Any] = [:]) throws -> Data {
        let latest: [String: Any] = ["version": "1.0", "build": 50, "minimumSystemVersion": "18.0", "url": "https://testflight.apple.com/join/Wgkx6k3V", "expiresAt": "2099-01-01T00:00:00Z"].merging(changes) { _, new in new }
        return try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "platform": "ios", "channel": "testflight", "latest": latest].merging(envelope) { _, new in new })
    }
    func testBuildNumberFindsUpdatesWithinSameMarketingVersionWithoutDowngrades() throws {
        XCTAssertEqual(AppRelease.update(from: try data(), channel: "testflight", installedBuild: 49, systemVersion: "18.0")?.build, 50)
        XCTAssertNil(AppRelease.update(from: try data(), channel: "testflight", installedBuild: 50, systemVersion: "18.0"))
        XCTAssertNil(AppRelease.update(from: try data(), channel: "testflight", installedBuild: 51, systemVersion: "18.0"))
        XCTAssertNotNil(AppRelease.update(from: try data(["minimumSystemVersion": "18.0.0"]), channel: "testflight", installedBuild: 49, systemVersion: "18.0"))
    }
    func testUnavailableIncompatibleExpiredMalformedAndWrongChannelFailOpen() throws {
        for changes: [String: Any] in [["build": -1], ["build": "50"], ["build": 2_147_483_648], ["version": "unknown"], ["minimumSystemVersion": "18.1"], ["minimumSystemVersion": "19.0"], ["url": "https://example.com/update"], ["expiresAt": "2020-01-01T00:00:00Z"], ["expiresAt": NSNull()]] {
            XCTAssertNil(AppRelease.update(from: try data(changes), channel: "testflight", installedBuild: 49, systemVersion: "18.0"), "\(changes)")
        }
        for envelope: [String: Any] in [["latest": NSNull()], ["platform": "android"], ["schemaVersion": 2], ["channel": "app-store"]] {
            XCTAssertNil(AppRelease.update(from: try data(envelope: envelope), channel: "testflight", installedBuild: 49, systemVersion: "18.0"))
        }
        XCTAssertNil(AppRelease.update(from: Data("not JSON".utf8), channel: "testflight", installedBuild: 49, systemVersion: "18.0"))
        XCTAssertNotNil(AppRelease.update(from: try data(["url": "https://apps.apple.com/app/id6816377222", "expiresAt": NSNull()], envelope: ["channel": "app-store"]), channel: "app-store", installedBuild: 49, systemVersion: "26.0"))
    }
}
