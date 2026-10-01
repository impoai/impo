import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct AppRelease: Decodable, Equatable, Sendable {
    public let version: String
    public let build: Int
    public let url: URL
    public let minimumSystemVersion: String
    public let expiresAt: String?

    public static func update(from data: Data, channel: String, installedBuild: Int,
                              systemVersion: String, now: Date = Date()) -> AppRelease? {
        struct Envelope: Decodable { let schemaVersion: Int; let platform: String; let channel: String; let latest: AppRelease? }
        let destinations = ["testflight": "https://testflight.apple.com/join/Wgkx6k3V", "app-store": "https://apps.apple.com/app/id6816377222"]
        guard data.count <= 8192, installedBuild > 0, let destination = destinations[channel],
              let envelope = try? JSONDecoder().decode(Envelope.self, from: data), envelope.schemaVersion == 1,
              envelope.platform == "ios", envelope.channel == channel, let release = envelope.latest,
              release.build > installedBuild, release.build <= 2_147_483_647,
              release.url.absoluteString == destination, numericVersion(release.version),
              numericVersion(release.minimumSystemVersion), numericVersion(systemVersion),
              systemIsCompatible(systemVersion, minimum: release.minimumSystemVersion) else { return nil }
        if channel == "testflight" {
            guard let expiry = release.expiresAt else { return nil }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let date = formatter.date(from: expiry) ?? ISO8601DateFormatter().date(from: expiry)
            guard let date, date > now else { return nil }
        }
        return release
    }

    private static func numericVersion(_ value: String) -> Bool {
        value.count <= 32 && value.range(of: #"^[0-9]+(?:\.[0-9]+){0,2}$"#, options: .regularExpression) != nil
    }
    private static func systemIsCompatible(_ current: String, minimum: String) -> Bool {
        let lhs = current.split(separator: ".").compactMap { Int($0) }
        let rhs = minimum.split(separator: ".").compactMap { Int($0) }
        guard lhs.count == current.split(separator: ".").count, rhs.count == minimum.split(separator: ".").count else { return false }
        for index in 0..<max(lhs.count, rhs.count) {
            let l = index < lhs.count ? lhs[index] : 0
            let r = index < rhs.count ? rhs[index] : 0
            if l != r { return l > r }
        }
        return true
    }
}

public enum AppReleaseClient {
    /// This public request never carries authentication, cookies or a user identifier.
    public static func check(channel: String, installedBuild: Int, systemVersion: String,
                             baseURL: URL = URL(string: "https://impo.ai")!) async -> AppRelease? {
        guard ["testflight", "app-store"].contains(channel) else { return nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 5
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: baseURL.appendingPathComponent("app-releases/ios-\(channel).json"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await session.data(for: request)
            guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                  response.mimeType == "application/json" else { return nil }
            return AppRelease.update(from: data, channel: channel, installedBuild: installedBuild, systemVersion: systemVersion)
        } catch { return nil }
    }
}
