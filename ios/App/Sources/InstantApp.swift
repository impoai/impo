import SwiftUI
import ClerkKit

@main
struct InstantApp: App {
    @UIApplicationDelegateAdaptor(ListeningAppDelegate.self) private var delegate
    @State private var model = AppModel()
    @State private var tasks = TasksModel()
    @State private var listening = ListeningModel()
    @State private var today = TodayModel()
    @State private var memories = MemoriesModel()
    @State private var permissions = ClientPermissions.make()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        if ClerkConfig.isConfigured { Clerk.configure(publishableKey: ClerkConfig.publishableKey) }
    }
    var body: some Scene {
        WindowGroup {
            Group {
                if model.isOnboarded { MainView() }
                else { OnboardingView() }
            }
            .environment(model)
            .environment(tasks)
            .environment(listening)
            .environment(today)
            .environment(memories)
            .environment(permissions)
            .task(id: "\(model.listeningScope ?? "offline")|\(model.isOnboarded)") {
                permissions.configure(scope: model.listeningScope)
                today.configure(scope: model.listeningScope, client: model.listeningClient())
                memories.configure(scope: model.listeningScope, client: model.listeningClient())
                await today.syncContext(displayName: model.displayName)
                await today.refresh()
                if model.isOnboarded { await permissions.activate(context: today) }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task {
                    await permissions.refreshStatus()
                    await today.syncContext(displayName: model.displayName)
                    await today.refresh()
                    if model.isOnboarded { await permissions.activate(context: today) }
                } }
            }
            .task(id: model.listeningScope) {
                listening.configure(scope: model.listeningScope, client: model.listeningClient())
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--preview-listening-activity") {
                    listening.previewListeningActivity()
                    if ProcessInfo.processInfo.arguments.contains("--preview-listening-paused") { listening.audioInterrupted() }
                }
                #endif
                while !Task.isCancelled {
                    await listening.sync(force: false)
                    await listening.pollTranscripts()
                    try? await Task.sleep(for: .seconds(10))
                }
            }
            .foregroundStyle(InstantStyle.ink)
            .tint(InstantStyle.ink)
            .preferredColorScheme(.light)
            .onOpenURL { url in
                if url.scheme == "ai.impo", url.host == "listening" {
                    model.selectedTab = 3
                    model.transcriptNavigationID = UUID()
                }
            }
            .task {
                await model.syncRealAuthFromClerkSession()
                if let index = ProcessInfo.processInfo.arguments.firstIndex(of: "--sign-in-ticket"),
                   ProcessInfo.processInfo.arguments.indices.contains(index + 1) {
                    try? await model.signIn(ticket: ProcessInfo.processInfo.arguments[index + 1])
                    model.isOnboarded = true
                }
            }
        }
    }
}
