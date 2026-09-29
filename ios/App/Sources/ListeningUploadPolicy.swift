import Foundation

struct ListeningUploadPolicy {
    enum Network { case offline, wifi, cellular }
    static func shouldUpload(oldest: Date, count: Int, now: Date, network: Network, charging: Bool, wifiOnly: Bool) -> Bool {
        guard count > 0, network != .offline, !wifiOnly || network == .wifi else { return false }
        let age = now.timeIntervalSince(oldest)
        return age >= 30 || count >= 5
    }
}
