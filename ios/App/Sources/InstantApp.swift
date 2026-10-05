import SwiftUI
import ClerkKit
import InstantClient

@main
struct InstantApp: App {
    @UIApplicationDelegateAdaptor(ListeningAppDelegate.self) private var delegate
    @State private var model = AppModel()
    @State private var tasks = TasksModel()
    @State private var listening = ListeningModel()
    @State private var today = TodayModel()
    @State private var memories = MemoriesModel()
    @State private var permissions = ClientPermissions.make()
    @State private var push = PushNotifications.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {
        PushNotifications.shared.start()
        if ClerkConfig.isConfigured { Clerk.configure(publishableKey: ClerkConfig.publishableKey) }
    }
    @ViewBuilder private var appContent: some View {
        if model.isOnboarded { MainView() } else { OnboardingView() }
    }

    var body: some Scene {
        WindowGroup {
            Group {
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--shopping-fixture") { ShoppingFixture() }
                else if ProcessInfo.processInfo.arguments.contains("--client-actions-fixture") { ClientActionsFixture() }
                else if ProcessInfo.processInfo.arguments.contains("--response-render-fixture") { ResponseRenderingFixture() }
                else if ProcessInfo.processInfo.arguments.contains("--account-deletion-fixture") { DeleteAccountView() }
                else { appContent }
                #else
                appContent
                #endif
            }
            .environment(model)
            .environment(tasks)
            .environment(listening)
            .environment(today)
            .environment(memories)
            .environment(permissions)
            .modifier(SoftUpgradePrompt())
            .task(id: model.listeningScope) {
                push.configure(scope: model.listeningScope, client: model.listeningClient())
                push.setForeground(scenePhase == .active)
                while !Task.isCancelled {
                    if scenePhase == .active { await push.refresh(); routePush(); await listening.refreshEchoSchedule() }
                    try? await Task.sleep(for: .seconds(20))
                }
            }
            .onChange(of: push.pendingRoute) { _, _ in routePush() }
            .task(id: "\(model.listeningScope ?? "offline")|\(model.isOnboarded)") {
                permissions.configure(scope: model.listeningScope)
                tasks.configure(scope: model.listeningScope)
                today.configure(scope: model.listeningScope, client: model.listeningClient())
                memories.configure(scope: model.listeningScope, client: model.listeningClient())
                routePush()
                await today.syncContext(displayName: model.displayName)
                await today.refresh()
                if model.isOnboarded { await permissions.activate(context: today) }
            }
            .onChange(of: scenePhase) { _, phase in
                push.setForeground(phase == .active)
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
                    try? await Task.sleep(for: .seconds(3))
                }
            }
            .task(id: model.listeningScope) {
                // Transcript updates must continue while a large local queue uploads.
                while !Task.isCancelled {
                    await listening.pollTranscripts()
                    try? await Task.sleep(for: .seconds(5))
                }
            }
            .foregroundStyle(InstantStyle.ink)
            .tint(InstantStyle.ink)
            .preferredColorScheme(.light)
            .sheet(isPresented: $model.showDeletionReceipt) { AccountDeletionReceiptView().environment(model).environment(listening) }
            .onOpenURL { url in
                if url.scheme == "ai.impo", url.host == "listening" {
                    model.selectedTab = 3
                    model.transcriptNavigationID = UUID()
                }
            }
            .task {
                await model.recoverAccountDeletion(listening: listening)
                if model.savedDeletion != nil { model.showDeletionReceipt = true }
                await model.syncRealAuthFromClerkSession()
                if let index = ProcessInfo.processInfo.arguments.firstIndex(of: "--sign-in-ticket"),
                   ProcessInfo.processInfo.arguments.indices.contains(index + 1) {
                    try? await model.signIn(ticket: ProcessInfo.processInfo.arguments[index + 1])
                    model.isOnboarded = true
                }
            }
        }
    }
    private func routePush() {
        guard model.isOnboarded, model.listeningScope != nil, let route = push.pendingRoute,
              route.isCurrent(registration: push.registrationId) else { return }
        switch route.category {
        case .chat: model.selectedTab = 0
        case .tasks, .scheduledTasks:
            tasks.configure(scope: model.listeningScope)
            model.selectedTab = 2; tasks.route = .detail(route.targetId)
        case .brief: model.selectedTab = 1; model.notificationBriefID = route.targetId
        case .echo: model.selectedTab = 3; model.transcriptNavigationID = UUID()
        }
        push.pendingRoute = nil
    }
}
