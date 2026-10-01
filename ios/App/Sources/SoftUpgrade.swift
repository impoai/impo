import SwiftUI
import StoreKit
import InstantClient

/// Process lifetime, independent of authentication, navigation and scene recreation.
@MainActor @Observable final class SoftUpgrade {
    static let shared = SoftUpgrade()
    private(set) var checked = false
    var available: AppRelease?

    func checkOnce() async {
        guard !checked else { return }
        checked = true
        guard let installed = (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String).flatMap(Int.init) else { return }
        #if DEBUG
        guard let fixture = ProcessInfo.processInfo.environment["IMPO_TEST_RELEASE_JSON"] else { return }
        available = AppRelease.update(from: Data(fixture.utf8), channel: "testflight", installedBuild: installed, systemVersion: UIDevice.current.systemVersion)
        #else
        let started = Date()
        guard let result = try? await AppTransaction.shared, case .verified(let transaction) = result,
              transaction.bundleID == Bundle.main.bundleIdentifier else { return }
        let channel: String
        switch transaction.environment {
        case .sandbox: channel = "testflight"
        case .production: channel = "app-store"
        default: return
        }
        let release = await AppReleaseClient.check(channel: channel, installedBuild: installed, systemVersion: UIDevice.current.systemVersion)
        // Never surface a late response after the user has started working.
        if Date().timeIntervalSince(started) < 15 { available = release }
        #endif
    }
}

struct SoftUpgradePrompt: ViewModifier {
    @State private var upgrade = SoftUpgrade.shared
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    func body(content: Content) -> some View {
        content
            .task(id: scenePhase) { if scenePhase == .active { await upgrade.checkOnce() } }
            .alert("Update available", isPresented: Binding(get: { upgrade.available != nil && scenePhase == .active }, set: { if !$0 { upgrade.available = nil } }), presenting: upgrade.available) { release in
                Button("Later", role: .cancel) { upgrade.available = nil }
                Button("Update") { upgrade.available = nil; openURL(release.url) }
            } message: { release in
                Text("Impo \(release.version) (\(release.build)) is available. You can update now or keep using this version.")
            }
    }
}
