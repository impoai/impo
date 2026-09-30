import SwiftUI
import InstantClient
import CryptoKit
import ClerkKit

struct ChatMessage: Identifiable, Codable, Equatable {
    var id: String = UUID().uuidString
    var role: String
    var text: String
}

@MainActor @Observable
final class AppModel {
    let deviceData: DeviceDataService
    let connectors = ConnectorsModel()
    let dictation = VoiceDictation()
    var calendarEnabled = false
    var healthEnabled = false
    var remindersEnabled = false
    var contactsEnabled = false
    var deviceConnectionStatus = "Connect your iPhone to use its data."
    var deviceToolStatus: String?
    /// Intermediate steps of the reply in progress; shown while it runs, then dropped.
    var liveSteps: [StreamStep] = []
    @ObservationIgnored private var deviceTask: Task<Void, Never>?
    @ObservationIgnored private var deviceOperationID = UUID()
    @ObservationIgnored private var isForeground = true
    var onboardingStep = 0
    var isOnboarded = false
    var assistantName = "Momo"
    var avatarIndex = 3
    /// The user's own name; empty until known (Clerk first name or edited in Memories).
    var displayName = ""
    /// "you" when the name is unknown, for phrases like "What I know about you".
    var nameOrYou: String { displayName.isEmpty ? "you" : displayName }
    var connectedServices: Set<String> = []
    var mode = "Balanced"
    var backendURL = "http://127.0.0.1:3001" {
        didSet {
            if oldValue != backendURL { configureConnectors() }
            if oldValue != backendURL && useLiveBackend {
                stopDeviceConnection()
                invalidateOperation()
                messages = []
                chatError = nil
            }
        }
    }
    var useLiveBackend = false {
        didSet { if oldValue != useLiveBackend { invalidateOperation(); stopDeviceConnection(); configureConnectors() } }
    }
    /// True once a real Clerk sign-in has completed; switches the token provider
    /// away from the fixed local-dev fixture identity. Settings → Development's
    /// live-backend toggle keeps working independently, for local testing against
    /// a server running in local-dev auth mode.
    var usesRealAuth = false
    /// Hidden tools (demo plan screens, local server, Echo logs). Tap the Settings
    /// avatar seven times to toggle; stays on this device across sign-outs.
    var debugMode = false {
        didSet { if oldValue != debugMode { defaults.set(debugMode, forKey: Self.debugModeKey) } }
    }
    nonisolated private static let debugModeKey = "instant.debugMode"
    var selectedTab = 0
    var transcriptNavigationID = UUID()
    var messages: [ChatMessage] = []
    var selectedScenario: String?
    var isThinking = false
    var chatError: String?
    @ObservationIgnored private var failedReplyInput: String?
    var activeSubmission: String?
    @ObservationIgnored private var responseTask: Task<Void, Never>?
    @ObservationIgnored private var operationID = UUID()
    nonisolated private static let liveIdentity = "instant-dev-alice"
    nonisolated static let productionServerURL = ClerkConfig.apiBaseURL
    nonisolated private static let productionHost = URLComponents(string: productionServerURL)?.host?.lowercased()
    nonisolated private static let productionPath = URLComponents(string: productionServerURL)?.path ?? ""
    private struct PendingInput: Codable {
        let clientID: String
        let text: String
        var deviceID: String?
        var clientContext: MessageClientContext?
        /// A voice message keeps its clip until the server accepts it; `text` stays empty.
        var audio: Data?
        var audioMimeType: String?
    }
    private struct LiveContext {
        let operationID: UUID
        let endpoint: URL
        let identity: String
        var scope: String { endpoint.absoluteString + "|" + identity }
    }
    /// All features use scope-bound handles to the same refreshable token store.
    private var activeTokenProvider: any InstantTokenProvider {
        usesRealAuth ? ClerkTokenProvider() : StaticInstantToken(Self.liveIdentity)
    }
    /// The identity that account-bound local state (pending input, device receipts,
    /// connectors) is keyed by: the actual Clerk user, never just "some Clerk user".
    private var activeIdentityTag: String {
        guard usesRealAuth else { return Self.liveIdentity }
        return "clerk:" + (Clerk.shared.user?.id ?? "signed-out")
    }
    nonisolated static let accountOwnerKey = "instant.accountOwner"
    /// Keys that describe this device or app build, not an account. Every other
    /// unscoped `instant.` key is account state and is cleared when the owner changes;
    /// `instant.listening.` keys already carry their account scope.
    nonisolated private static let deviceKeys: Set<String> = ["instant.installationID", debugModeKey, accountOwnerKey,
        "instant.backend", "instant.live", "instant.appliedBuildServer"]

    /// Drives the existing onboarding login buttons with a real Clerk sign-in;
    /// on success this app talks to the real deployed backend under the signed-in
    /// user's identity instead of the fixed local-dev fixture.
    func signIn(with brand: LoginBrand) async throws {
        try requireAuthConfiguration()
        let provider: OAuthProvider = switch brand {
        case .google: .google
        case .apple: .apple
        }
        if provider == .apple {
            try await Clerk.shared.auth.signInWithApple()
        } else {
            try await Clerk.shared.auth.signInWithOAuth(provider: provider)
        }
        try didSignIn()
    }

    /// A one-time server-minted token (Backend API's /sign_in_tokens), used
    /// only by automated tests to sign in for real without any UI - there is
    /// no first-party UI path that calls this.
    func signIn(ticket: String) async throws {
        try requireAuthConfiguration()
        _ = try await Clerk.shared.auth.signInWithTicket(ticket)
        try didSignIn()
    }

    private func requireAuthConfiguration() throws {
        guard ClerkConfig.isConfigured else {
            throw NSError(domain: "ImpoConfiguration", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Configure Clerk in Config.local.xcconfig to sign in. See the iOS setup guide."])
        }
    }

    private func didSignIn() throws {
        guard Clerk.shared.session != nil, Clerk.shared.user != nil else { throw ClerkTokenError.notSignedIn }
        usesRealAuth = true
        adoptAccount(activeIdentityTag)
        #if !DEBUG
        // Release pairs the production Clerk instance with the deployed
        // production backend (see ClerkConfig). A Debug build's real sign-in
        // uses the Dev Clerk instance instead - its tokens only verify against
        // a locally-run server in clerk auth mode with matching Dev keys, not
        // the deployed production server, so backendURL/useLiveBackend are
        // deliberately left alone there (whatever local/LAN target the
        // developer already configured in Settings).
        if !useLiveBackend || backendURL == "http://127.0.0.1:3001" {
            backendURL = Self.productionServerURL
        }
        useLiveBackend = true
        #endif
        configureConnectors()
    }

    /// Local account state belongs to exactly one identity. Sign-out clears it, but an
    /// identity can also change without it (an expired or revoked session followed by a
    /// different sign-in, or Clerk restoring another account), so every sign-in re-checks.
    func adoptAccount(_ identity: String) {
        let owner = defaults.string(forKey: Self.accountOwnerKey)
        guard owner != identity else { return }
        if owner != nil { clearAccountState() }
        else if identity.hasPrefix("clerk:") {
            // Before owners were recorded, every Clerk account shared the "|clerk" input slot.
            // Its only possible owner is the account this install was already signed in to.
            var inputs = pendingInputs
            for key in inputs.keys where key.hasSuffix("|clerk") {
                inputs[String(key.dropLast("clerk".count)) + identity] = inputs.removeValue(forKey: key)
            }
            pendingInputs = inputs
        }
        defaults.set(identity, forKey: Self.accountOwnerKey)
    }

    /// Drop another account's profile, pending input, device consent and visible chat.
    private func clearAccountState() {
        invalidateOperation()
        stopDeviceConnection()
        for key in defaults.dictionaryRepresentation().keys
        where key.hasPrefix("instant.") && !key.hasPrefix("instant.listening.") && !Self.deviceKeys.contains(key) {
            defaults.removeObject(forKey: key)
        }
        isOnboarded = false; selectedTab = 0
        assistantName = "Momo"; displayName = ""; avatarIndex = 3; connectedServices = []; mode = "Balanced"
        messages = []; liveSteps = []; selectedScenario = nil; isThinking = false; chatError = nil; activeSubmission = nil
        calendarEnabled = false; healthEnabled = false; remindersEnabled = false; contactsEnabled = false
    }

    /// Clerk restores a signed-in session from the Keychain on launch (it
    /// survives app reinstalls), but `usesRealAuth` starts false every fresh
    /// process. Call once at startup so a returning signed-in user's requests
    /// use their real session token instead of silently falling back to the
    /// local-dev fixture identity.
    /// The signed-in account, for Settings. Nil in offline Demo or local-dev identity.
    var accountEmail: String? { usesRealAuth && ClerkConfig.isConfigured ? Clerk.shared.user?.primaryEmailAddress?.emailAddress : nil }
    var accountImageURL: URL? {
        guard usesRealAuth, ClerkConfig.isConfigured, let user = Clerk.shared.user, user.hasImage else { return nil }
        return URL(string: user.imageUrl)
    }
    var accountName: String {
        if !displayName.isEmpty { return displayName }
        guard usesRealAuth, ClerkConfig.isConfigured, let user = Clerk.shared.user else { return "" }
        return [user.firstName, user.lastName].compactMap { $0?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// End the Clerk session and clear this device's per-user state, then return to sign-in.
    /// Queued Echo audio stays on disk bound to its owner and resumes on that account's next sign-in.
    func signOut() async throws {
        if ClerkConfig.isConfigured, Clerk.shared.session != nil { try await Clerk.shared.auth.signOut() }
        usesRealAuth = false
        resetDemo()
        onboardingStep = 1
    }

    func syncRealAuthFromClerkSession() async {
        guard ClerkConfig.isConfigured else { return }
        while !Clerk.shared.isLoaded {
            guard !Task.isCancelled else { return }
            try? await Task.sleep(for: .milliseconds(50))
        }
        if Clerk.shared.session != nil { try? didSignIn() }
        // A saved session can outlive local state (reinstall, sign-out on another build).
        if usesRealAuth && !isOnboarded { _ = await restoreAccountProfile() }
        if displayName.isEmpty, let first = Clerk.shared.user?.firstName?.trimmingCharacters(in: .whitespacesAndNewlines), !first.isEmpty {
            displayName = String(first.prefix(40)); persistProfile()
        }
    }
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let session: URLSession

    init(defaults: UserDefaults = .standard, session: URLSession = .shared) {
        self.defaults = defaults
        self.session = session
        if ProcessInfo.processInfo.arguments.contains("--reset-demo") {
            for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("instant.") && key != "instant.installationID" { defaults.removeObject(forKey: key) }
        }
        debugMode = defaults.bool(forKey: Self.debugModeKey) || ProcessInfo.processInfo.arguments.contains("--debug-mode")
        deviceData = DeviceDataService()
        calendarEnabled = defaults.bool(forKey: "instant.device.calendarEnabled")
        healthEnabled = defaults.bool(forKey: "instant.device.healthEnabled")
        remindersEnabled = defaults.bool(forKey: "instant.device.remindersEnabled")
        contactsEnabled = defaults.bool(forKey: "instant.device.contactsEnabled")
        isOnboarded = defaults.bool(forKey: "instant.onboarded")
        assistantName = defaults.string(forKey: "instant.name") ?? "Momo"
        // "Demo" was the old placeholder default, never a name the user chose.
        displayName = defaults.string(forKey: "instant.displayName").flatMap { $0 == "Demo" ? nil : $0 } ?? ""
        avatarIndex = defaults.object(forKey: "instant.avatar") as? Int ?? 3
        connectedServices = Set(defaults.stringArray(forKey: "instant.connections") ?? [])
        mode = defaults.string(forKey: "instant.mode") ?? "Balanced"
        backendURL = defaults.string(forKey: "instant.backend") ?? "http://127.0.0.1:3001"
        useLiveBackend = defaults.bool(forKey: "instant.live")
        #if DEBUG
        if let buildServer = Bundle.main.object(forInfoDictionaryKey: "InstantDevelopmentServerURL") as? String,
           !buildServer.isEmpty, !buildServer.contains("$("), defaults.string(forKey: "instant.appliedBuildServer") != buildServer {
            backendURL = buildServer
            useLiveBackend = true
            defaults.set(buildServer, forKey: "instant.backend")
            defaults.set(true, forKey: "instant.live")
            defaults.set(buildServer, forKey: "instant.appliedBuildServer")
        }
        #endif
        if let index = ProcessInfo.processInfo.arguments.firstIndex(of: "--live-backend"), ProcessInfo.processInfo.arguments.indices.contains(index + 1) {
            backendURL = ProcessInfo.processInfo.arguments[index + 1]
            useLiveBackend = true
        }
        selectedScenario = defaults.string(forKey: "instant.scenario")
        if !useLiveBackend { loadDemoMessages() }
        if ProcessInfo.processInfo.arguments.contains("--show-main") { isOnboarded = true }
        if let index = ProcessInfo.processInfo.arguments.firstIndex(of: "--onboarding-step"), ProcessInfo.processInfo.arguments.indices.contains(index + 1) {
            onboardingStep = Int(ProcessInfo.processInfo.arguments[index + 1]) ?? 0
            isOnboarded = false
        }
        configureConnectors()
    }

    func persistProfile() {
        defaults.set(isOnboarded, forKey: "instant.onboarded")
        defaults.set(assistantName, forKey: "instant.name")
        defaults.set(displayName, forKey: "instant.displayName")
        defaults.set(avatarIndex, forKey: "instant.avatar")
        defaults.set(Array(connectedServices), forKey: "instant.connections")
        defaults.set(mode, forKey: "instant.mode")
        defaults.set(backendURL, forKey: "instant.backend")
        defaults.set(useLiveBackend, forKey: "instant.live")
    }

    func completeOnboarding() {
        assistantName = assistantName.trimmingCharacters(in: .whitespacesAndNewlines)
        if assistantName.isEmpty { assistantName = "Momo" }
        isOnboarded = true
        persistProfile()
        syncAccountProfile(onboarded: true)
    }

    /// A returning account skips onboarding: restore what the server remembers and report
    /// whether this account already finished it. Offline or Demo returns false.
    func restoreAccountProfile() async -> Bool {
        guard let scope = listeningScope, let client = liveClient(), let profile = try? await client.profile(),
              !Task.isCancelled, listeningScope == scope else { return false }
        if let name = profile.assistantName { assistantName = name }
        // Index 6 is a photo kept only on the device that chose it.
        if let index = profile.avatarIndex, index != 6 || defaults.data(forKey: "instant.avatarPhoto") != nil { avatarIndex = index }
        if let name = profile.displayName, !name.isEmpty { displayName = name }
        if profile.onboarded { isOnboarded = true }
        persistProfile()
        return profile.onboarded
    }

    /// Save the assistant's name and look to the account. Best effort; local state stays authoritative on this device.
    func syncAccountProfile(onboarded: Bool = false) {
        guard let client = liveClient() else { return }
        let name = assistantName, avatar = avatarIndex
        Task { _ = try? await client.updateProfile(assistantName: name, avatarIndex: avatar, onboarded: onboarded ? true : nil) }
    }

    func resetDemo() {
        invalidateOperation()
        stopDeviceConnection()
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("instant.") && key != "instant.installationID" && key != Self.debugModeKey { defaults.removeObject(forKey: key) }
        isOnboarded = false; onboardingStep = 0; selectedTab = 0
        assistantName = "Momo"; displayName = ""; avatarIndex = 3; connectedServices = []; messages = []
        selectedScenario = nil; isThinking = false; chatError = nil; activeSubmission = nil
        useLiveBackend = false; mode = "Balanced"; backendURL = "http://127.0.0.1:3001"
        calendarEnabled = false; healthEnabled = false; remindersEnabled = false; contactsEnabled = false
    }

    func chooseScenario(_ title: String) {
        selectedScenario = title
        defaults.set(title, forKey: "instant.scenario")
        send(title == "Something else" ? "I have something else in mind" : "Let's start with \(title.lowercased()).")
    }

    /// The local-dev identity only talks to a loopback/private-network origin
    /// with no path. The locally configured production origin is also allowed
    /// at its configured path.
    private func endpoint() throws -> URL {
        guard var parts = URLComponents(string: backendURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["http", "https"].contains(parts.scheme?.lowercased() ?? ""),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil
        else { throw URLError(.badURL) }
        let host = parts.host?.lowercased() ?? ""
        let isProduction = host == Self.productionHost
        guard isProduction ? parts.path == Self.productionPath
            : Self.isLocalDevelopmentHost(host) && (parts.path.isEmpty || parts.path == "/")
        else { throw URLError(.badURL) }
        parts.scheme = parts.scheme?.lowercased()
        parts.host = host
        parts.path = isProduction ? Self.productionPath : ""
        if (parts.scheme == "http" && parts.port == 80) || (parts.scheme == "https" && parts.port == 443) { parts.port = nil }
        guard let url = parts.url else { throw URLError(.badURL) }
        return url
    }

    nonisolated private static func isLocalDevelopmentHost(_ host: String) -> Bool {
        if ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host) { return true }
        if host.hasSuffix(".local") {
            let labels = host.split(separator: ".", omittingEmptySubsequences: false)
            let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-")
            return host.count <= 253 && labels.count >= 2 && labels.allSatisfy { label in
                !label.isEmpty && label.count <= 63 && label.first != "-" && label.last != "-"
                    && label.unicodeScalars.allSatisfy(allowed.contains)
            }
        }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count == 4 else { return false }
        var bytes: [Int] = []
        for label in labels {
            guard let value = Int(label), (0...255).contains(value), String(value) == label else { return false }
            bytes.append(value)
        }
        return bytes[0] == 10 || (bytes[0] == 172 && (16...31).contains(bytes[1]))
            || (bytes[0] == 192 && bytes[1] == 168)
    }

    /// A client for live features outside the main chat (such as Tasks), or nil in offline Demo.
    func liveClient() -> InstantClient? {
        guard useLiveBackend, let url = try? endpoint() else { return nil }
        return InstantClient(baseURL: url, tokenProvider: activeTokenProvider, session: session)
    }

    /// Audio queues are isolated by endpoint AND the actual signed-in account.
    var listeningScope: String? {
        guard useLiveBackend, let url = try? endpoint() else { return nil }
        if usesRealAuth {
            guard let id = Clerk.shared.user?.id else { return nil }
            return url.absoluteString + "|clerk:" + id
        }
        return url.absoluteString + "|" + Self.liveIdentity
    }

    func listeningClient() -> InstantClient? {
        guard listeningScope != nil, let url = try? endpoint() else { return nil }
        if usesRealAuth, let id = Clerk.shared.user?.id {
            return InstantClient(baseURL: url, tokenProvider: ListeningTokenProvider(userID: id), session: session)
        }
        return InstantClient(baseURL: url, bearerToken: Self.liveIdentity, session: session)
    }

    private func invalidateOperation() {
        operationID = UUID()
        responseTask?.cancel()
        responseTask = nil
        isThinking = false
        activeSubmission = nil
        failedReplyInput = nil
    }

    private func isCurrent(_ context: LiveContext) -> Bool {
        !Task.isCancelled && useLiveBackend && operationID == context.operationID && (try? endpoint()) == context.endpoint
            && activeIdentityTag == context.identity
    }

    private func check(_ context: LiveContext) throws {
        guard isCurrent(context) else { throw CancellationError() }
    }

    private var pendingInputs: [String: PendingInput] {
        get {
            guard let data = defaults.data(forKey: "instant.pendingLiveInputs"),
                  let inputs = try? JSONDecoder().decode([String: PendingInput].self, from: data) else { return [:] }
            return inputs
        }
        set { defaults.set(try? JSONEncoder().encode(newValue), forKey: "instant.pendingLiveInputs") }
    }

    @discardableResult
    func send(_ raw: String) -> Bool {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isThinking else { return false }
        guard text.utf16.count <= 32_768, !text.contains("\0") else {
            chatError = "Please shorten this message to 32,768 characters or fewer and remove null characters."
            return false
        }
        if useLiveBackend {
            do {
                let url = try endpoint()
                let scope = url.absoluteString + "|" + activeIdentityTag
                guard pendingInputs[scope] == nil else {
                    chatError = "Your last message is still waiting for confirmation. Tap Retry before sending another."
                    return false
                }
                let pending = PendingInput(clientID: UUID().uuidString, text: text,
                    clientContext: MessageClientContext(timeZone: TimeZone.current.identifier, currentDate: ISO8601DateFormatter().string(from: Date())))
                // Save the retry identity before starting HTTP. Mode changes and
                // process termination must never turn a retry into a new input.
                pendingInputs[scope] = pending
                messages.append(ChatMessage(id: pending.clientID, role: "user", text: text))
                ListeningDiagnostics.shared.record("chat.send_started", ["clientMessageId":pending.clientID])
                startLive(endpoint: url)
            } catch {
                chatError = "Use a loopback or private local-network server origin, such as http://192.168.1.10:3001, without a path or credentials."
                return false
            }
        } else {
            invalidateOperation()
            let token = operationID
            messages.append(ChatMessage(role: "user", text: text))
            chatError = nil
            isThinking = true
            saveDemoMessages()
            responseTask = Task {
                try? await Task.sleep(for: .milliseconds(650))
                guard !Task.isCancelled, operationID == token, !useLiveBackend else { return }
                messages.append(ChatMessage(role: "assistant", text: demoReply(to: text)))
                isThinking = false
                responseTask = nil
                saveDemoMessages()
            }
        }
        if selectedScenario == nil {
            selectedScenario = "Something else"
            defaults.set(selectedScenario, forKey: "instant.scenario")
        }
        return true
    }

    /// A user message whose text is still being transcribed on the server.
    var awaitingTranscript: Bool { messages.last.map { $0.role == "user" && $0.text.isEmpty } ?? false }

    /// Send a hold-to-talk clip. A "…" bubble stands in for the message until the server
    /// returns its transcript; the server starts the reply from that same text.
    @discardableResult
    func sendVoice(_ clip: VoiceClip) -> Bool {
        guard !isThinking, !awaitingTranscript else { return false }
        guard useLiveBackend else {
            // Demo mode has no server to transcribe; UI tests supply the transcript.
            // Without a transcript the caller falls back to `transcribe`, which explains why.
            guard let text = clip.fixtureTranscript else { return false }
            let placeholder = ChatMessage(role: "user", text: "")
            messages.append(placeholder)
            Task {
                try? await Task.sleep(for: .milliseconds(1500))
                messages.removeAll { $0.id == placeholder.id }
                send(text)
            }
            return true
        }
        do {
            let url = try endpoint()
            let scope = url.absoluteString + "|" + activeIdentityTag
            guard pendingInputs[scope] == nil else {
                chatError = "Your last message is still waiting for confirmation. Tap Retry before sending another."
                return false
            }
            let pending = PendingInput(clientID: UUID().uuidString, text: "",
                clientContext: MessageClientContext(timeZone: TimeZone.current.identifier, currentDate: ISO8601DateFormatter().string(from: Date())),
                audio: clip.data, audioMimeType: clip.mimeType)
            pendingInputs[scope] = pending
            messages.append(ChatMessage(id: pending.clientID, role: "user", text: ""))
            ListeningDiagnostics.shared.record("chat.voice_send_started", ["clientMessageId":pending.clientID,"bytes":String(clip.data.count)])
            startLive(endpoint: url)
        } catch {
            chatError = "Use a loopback or private local-network server origin, such as http://192.168.1.10:3001, without a path or credentials."
            return false
        }
        if selectedScenario == nil {
            selectedScenario = "Something else"
            defaults.set(selectedScenario, forKey: "instant.scenario")
        }
        return true
    }

    /// Text for a clip without sending it, e.g. to start a task from speech.
    func transcribe(_ clip: VoiceClip) async throws -> String {
        guard useLiveBackend else {
            guard let text = clip.fixtureTranscript else { throw VoiceTranscriptionError.needsServer }
            try await Task.sleep(for: .milliseconds(800))
            return text
        }
        let api = InstantClient(baseURL: try endpoint(), tokenProvider: activeTokenProvider, session: session)
        return try await api.transcribeVoice(audio: clip.data, mimeType: clip.mimeType)
    }

    @discardableResult
    private func startLive(endpoint: URL) -> Task<Void, Never> {
        invalidateOperation()
        let context = LiveContext(operationID: operationID, endpoint: endpoint, identity: activeIdentityTag)
        let api = InstantClient(baseURL: endpoint, tokenProvider: activeTokenProvider, session: session)
        startDeviceConnection()
        isThinking = true
        liveSteps = []
        chatError = nil
        let task = Task { [self] in
            defer {
                if isCurrent(context) { isThinking = false; responseTask = nil }
            }
            var failures = 0
            while true {
                do {
                    if var pending = pendingInputs[context.scope] {
                        if !messages.contains(where: { $0.id == pending.clientID }) {
                            messages.append(ChatMessage(id: pending.clientID, role: "user", text: pending.text))
                        }
                        if pending.clientContext != nil && pending.deviceID == nil {
                            let device = try await api.registerDevice(installationId: installationID, tools: availableDeviceTools)
                            try check(context)
                            pending.deviceID = device.deviceId
                            pendingInputs[context.scope] = pending
                        }
                        let receipt: (messageId: String, submissionId: String)
                        if let audio = pending.audio {
                            // One request: the server transcribes, accepts that text and starts the reply.
                            let voice = try await api.sendVoiceMessage(clientMessageId: pending.clientID, audio: audio,
                                mimeType: pending.audioMimeType ?? "audio/mp4", deviceId: pending.deviceID, clientContext: pending.clientContext)
                            try check(context)
                            if let index = messages.firstIndex(where: { $0.id == pending.clientID }) { messages[index].text = voice.text }
                            receipt = (voice.messageId, voice.submissionId)
                        } else {
                            let sent = try await api.sendMessage(clientMessageId: pending.clientID, text: pending.text,
                                deviceId: pending.deviceID, clientContext: pending.clientContext)
                            try check(context)
                            receipt = (sent.messageId, sent.submissionId)
                        }
                        ListeningDiagnostics.shared.record("chat.message_accepted", ["clientMessageId":pending.clientID,"submissionId":receipt.submissionId])
                        if pendingInputs[context.scope]?.clientID == pending.clientID { pendingInputs.removeValue(forKey: context.scope) }
                        if let index = messages.firstIndex(where: { $0.id == pending.clientID }) { messages[index].id = receipt.messageId }
                    }
                    try await recover(api: api, context: context)
                    return
                } catch {
                    guard isCurrent(context) else { return }
                    if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
                    if (error as? InstantAPIError)?.code == "empty_transcript", let pending = pendingInputs[context.scope], pending.audio != nil {
                        // Nothing was accepted; drop the clip and its "…" bubble instead of offering a retry.
                        pendingInputs.removeValue(forKey: context.scope)
                        messages.removeAll { $0.id == pending.clientID }
                        chatError = "Didn't catch that. Hold the input field while you speak, then release."
                        return
                    }
                    // Resending is safe (the pending input keeps its clientMessageId); a dropped
                    // stream or brief outage reconnects before asking the user to retry.
                    failures += 1
                    if isTransientNetworkError(error), failures <= 3 {
                        ListeningDiagnostics.shared.record("chat.stream_reconnect", ["attempt": String(failures)])
                        try? await Task.sleep(for: .seconds(1 << (failures - 1)))
                        continue
                    }
                    var fields: [String:String] = ["phase": "send_or_recover"]
                    if let apiError = error as? InstantAPIError {
                        fields["status"] = String(apiError.statusCode)
                        fields["reason"] = apiError.code
                        fields["requestId"] = apiError.requestId
                    }
                    ListeningDiagnostics.shared.error("chat.request_failed", error, fields)
                    chatError = "Couldn't reach Impo. Tap Retry to reconnect; your message won't be sent twice."
                    return
                }
            }
        }
        responseTask = task
        return task
    }

    private func recover(api: InstantClient, context: LiveContext) async throws {
        while true {
            try check(context)
            var all: [ConversationMessage] = []
            var active: [ActiveSubmission] = []
            var after = 0
            var finishedPages = false
            for _ in 0..<1000 {
                let page = try await api.conversation(afterSequence: after)
                try check(context)
                all.append(contentsOf: page.messages)
                active = page.activeSubmissions
                if !page.hasMore { finishedPages = true; break }
                guard page.nextAfterSequence > after else { throw InstantClientError.invalidResponse }
                after = page.nextAfterSequence
            }
            guard finishedPages else { throw InstantClientError.invalidResponse }
            let ordered = all.sorted { $0.sequence < $1.sequence }
            var seen = Set<String>()
            messages = ordered.filter { !$0.text.isEmpty && seen.insert($0.id).inserted }
                .map { ChatMessage(id: $0.id, role: $0.role, text: $0.text) }
            chatError = nil
            failedReplyInput = nil
            if active.isEmpty, let lastReply = ordered.last, lastReply.role == "assistant" {
                if lastReply.status == "failed" {
                    // The original submission was acknowledged and is terminal.
                    // Retry must create a NEW submission for its original input;
                    // replaying its old id would only return the failed receipt.
                    failedReplyInput = ordered.last(where: { $0.role == "user" && $0.sequence < lastReply.sequence })?.text
                    chatError = "The last reply couldn't be completed. Tap Retry to try your request again."
                    ListeningDiagnostics.shared.record("chat.reply_failed", ["messageId":lastReply.id,"phase":"history"])
                } else if lastReply.status == "cancelled" {
                    failedReplyInput = ordered.last(where: { $0.role == "user" && $0.sequence < lastReply.sequence })?.text
                    chatError = "The last reply was cancelled. Tap Retry to try your request again."
                }
            }
            guard !active.isEmpty else { activeSubmission = nil; return }
            // Each subscription has its own reducer. Re-read history after the
            // queue drains so later queued submissions are never left stranded.
            for submission in active {
                try check(context)
                activeSubmission = submission.submissionId
                try await consume(api: api, submissionID: submission.submissionId, context: context)
            }
        }
    }

    private func consume(api: InstantClient, submissionID: String, context: LiveContext) async throws {
        for try await state in api.stream(submissionId: submissionID) {
            try check(context)
            deviceToolStatus = state.status == "waiting_device" ? "Waiting for your iPhone to read the requested data…" : nil
            liveSteps = state.done ? [] : state.steps
            if let id = state.messageId, !state.text.isEmpty {
                if let index = messages.firstIndex(where: { $0.id == id }) { messages[index].text = state.text }
                else { messages.append(ChatMessage(id: id, role: "assistant", text: state.text)) }
            }
            if !state.errors.isEmpty || state.status == "failed" { chatError = "This reply couldn't be completed. You can send a new message." }
            if state.aborted || state.status == "cancelled" { chatError = "This reply was cancelled." }
            if state.done { activeSubmission = nil }
        }
        try check(context)
    }

    func retry() {
        guard useLiveBackend, !isThinking else { return }
        if let text = failedReplyInput {
            ListeningDiagnostics.shared.record("chat.retry", ["reason":"failed_reply_new_attempt"])
            _ = send(text)
            return
        }
        // Unacknowledged messages retain their durable clientMessageId. A
        // disconnected subscription only reconnects; it must not resend input.
        ListeningDiagnostics.shared.record("chat.retry", ["reason":"recover_existing_attempt"])
        do { startLive(endpoint: try endpoint()) }
        catch { chatError = "Use a loopback or private local-network server origin, such as http://192.168.1.10:3001, without a path or credentials." }
    }

    func restoreConversation() async {
        isForeground = true
        configureConnectors()
        connectors.resume()
        deviceData.refreshAuthorizationStatus()
        startDeviceConnection()
        guard useLiveBackend, !isThinking else { return }
        do {
            let task = startLive(endpoint: try endpoint())
            await task.value
        } catch { chatError = "Use a loopback or private local-network server origin, such as http://192.168.1.10:3001, without a path or credentials." }
    }

    func suspendStream() {
        isForeground = false
        connectors.pause()
        stopDeviceConnection()
        guard useLiveBackend else { return }
        invalidateOperation()
        // The server owns the run; closing this subscription never cancels it.
    }

    func changeChatMode() {
        invalidateOperation()
        stopDeviceConnection()
        chatError = nil
        messages = []
        if useLiveBackend { Task { await restoreConversation() } }
        else { loadDemoMessages() }
        persistProfile()
    }

    private func configureConnectors() {
        connectors.configure(endpoint: useLiveBackend ? (try? endpoint()) : nil, identityTag: activeIdentityTag, tokenProvider: activeTokenProvider)
    }

    func refreshConnectors() {
        configureConnectors()
        if isForeground { connectors.reload() }
    }

    private var installationID: String {
        if let value = defaults.string(forKey: "instant.installationID") { return value }
        let value = UUID().uuidString
        defaults.set(value, forKey: "instant.installationID")
        return value
    }

    private var availableDeviceTools: [String] {
        // Advertising an opted-in capability does not promise that HealthKit has data.
        var tools: [String] = []
        if calendarEnabled && deviceData.canReadCalendar { tools.append("ios_list_calendar_events") }
        if healthEnabled && deviceData.healthAccessRequested { tools.append("ios_get_health_summary") }
        if remindersEnabled && deviceData.canUseReminders { tools += ["impo_list_reminders", "impo_create_reminder"] }
        if contactsEnabled && deviceData.canReadContacts { tools.append("impo_search_contacts") }
        return tools
    }

    func connectDeviceData(_ kind: String) async {
        if kind == "calendar" {
            await deviceData.requestCalendarAccess()
            calendarEnabled = deviceData.canReadCalendar
        } else if kind == "health" {
            await deviceData.requestHealthAccess()
            healthEnabled = deviceData.healthAccessRequested
        } else if kind == "reminders" {
            await deviceData.requestRemindersAccess()
            remindersEnabled = deviceData.canUseReminders
        } else if kind == "contacts" {
            await deviceData.requestContactsAccess()
            contactsEnabled = deviceData.canReadContacts
        }
        saveDevicePreferences()
        stopDeviceConnection()
        startDeviceConnection()
    }

    func disconnectDeviceData(_ kind: String) {
        if kind == "calendar" { calendarEnabled = false }
        if kind == "health" { healthEnabled = false }
        if kind == "reminders" { remindersEnabled = false }
        if kind == "contacts" { contactsEnabled = false }
        saveDevicePreferences()
        stopDeviceConnection()
        startDeviceConnection()
    }

    private func saveDevicePreferences() {
        defaults.set(calendarEnabled, forKey: "instant.device.calendarEnabled")
        defaults.set(healthEnabled, forKey: "instant.device.healthEnabled")
        defaults.set(remindersEnabled, forKey: "instant.device.remindersEnabled")
        defaults.set(contactsEnabled, forKey: "instant.device.contactsEnabled")
    }

    private func stopDeviceConnection() {
        deviceOperationID = UUID()
        deviceTask?.cancel()
        deviceTask = nil
        deviceToolStatus = nil
    }

    private func startDeviceConnection() {
        guard useLiveBackend, isForeground, deviceTask == nil, let url = try? endpoint() else { return }
        let token = deviceOperationID
        let identity = activeIdentityTag
        let api = InstantClient(baseURL: url, tokenProvider: activeTokenProvider, session: session)
        deviceConnectionStatus = "Connecting your iPhone…"
        deviceTask = Task { [self] in
            while !Task.isCancelled && deviceOperationID == token && useLiveBackend {
                do {
                    let registered = try await api.registerDevice(installationId: installationID, tools: availableDeviceTools)
                    try Task.checkCancellation()
                    guard deviceOperationID == token else { return }
                    let scope = url.absoluteString + "|" + identity + "|" + registered.deviceId
                    let hash = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
                    let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                    let runner = try DeviceToolRunner(transport: api, deviceID: registered.deviceId,
                        receiptFile: directory.appendingPathComponent("DeviceReceipts/\(hash).json"),
                        nonRepeatableTools: ["impo_create_reminder"])
                    deviceConnectionStatus = "iPhone connected · data is read only when you ask."
                    while !Task.isCancelled && deviceOperationID == token && useLiveBackend {
                        try await runner.poll(isEnabled: { [self] invocation in
                            await deviceToolAllowed(invocation.toolName, operation: token)
                        }) { [self] invocation in
                            try await executeDeviceInvocation(invocation, operation: token)
                        }
                        try await Task.sleep(for: .seconds(1))
                    }
                } catch {
                    guard !Task.isCancelled, deviceOperationID == token else { return }
                    deviceConnectionStatus = "iPhone connection paused. Reconnecting…"
                    try? await Task.sleep(for: .seconds(3))
                }
            }
        }
    }

    private func deviceToolAllowed(_ name: String, operation: UUID) -> Bool {
        deviceOperationID == operation && isForeground && useLiveBackend && availableDeviceTools.contains(name)
    }

    private func executeDeviceInvocation(_ invocation: PendingInvocation, operation: UUID) async throws -> DeviceToolExecutionResult {
        guard deviceOperationID == operation, isForeground, useLiveBackend, !Task.isCancelled else {
            throw CancellationError()
        }
        guard availableDeviceTools.contains(invocation.toolName) else {
            return DeviceToolExecutionResult(success: false, error: "permission_required")
        }
        deviceToolStatus = switch invocation.toolName {
        case "ios_list_calendar_events": "Reading your calendar…"
        case "impo_list_reminders": "Reading your reminders…"
        case "impo_create_reminder": "Adding a reminder…"
        case "impo_search_contacts": "Looking up your contacts…"
        default: "Reading the Health data you selected…"
        }
        let result = await deviceData.execute(toolName: invocation.toolName, input: invocation.input)
        if deviceOperationID == operation { deviceToolStatus = nil }
        if !result.success && (Task.isCancelled || result.error == "cancelled") { throw CancellationError() }
        return result
    }

    private func loadDemoMessages() {
        if let data = defaults.data(forKey: "instant.demoChat"), let saved = try? JSONDecoder().decode([ChatMessage].self, from: data) { messages = saved }
    }

    private func saveDemoMessages() { defaults.set(try? JSONEncoder().encode(messages), forKey: "instant.demoChat") }

    private func demoReply(to text: String) -> String {
        let lower = text.lowercased()
        if text.range(of: "[\\p{Han}]", options: .regularExpression) != nil {
            if text.contains("通讯录") || text.contains("短信") { return "现在是 Demo 模式，还没有读取你的通讯录，也不会发送短信。你可以先体验聊天、日程和任务的流程。" }
            return "我可以帮你梳理想法、安排一天，或者一起做个计划。这里先用示例回复体验流程。你想先从哪件事开始？"
        }
        if lower.contains("schedule") || lower.contains("calendar") { return "Let's make a little room in your day. In the demo calendar, you have a design catch-up at 10:30 and a free afternoon. What would you like to make time for?" }
        if lower.contains("work") || lower.contains("project") { return "Let's start with what matters most. What's one thing you'd like to move forward today? We can break it into a few small steps." }
        if lower.contains("health") { return "A gentler routine is a good place to start. Would you like to plan time for a walk, a workout, or a little more rest? No health data is connected in this demo." }
        if lower.contains("travel") { return "Somewhere new, or somewhere familiar? Tell me where you're thinking of going and we'll sketch out a plan." }
        if lower.contains("something else") { return "Sure, what's on your mind?" }
        if lower.contains("hello") || lower == "hi" { return "Hey! How's your day going?" }
        return "I'm here. We can turn that into a plan, make a task, or just talk it through. What would feel most helpful?"
    }
}

/// Failures worth reconnecting automatically: network drops, a stream cut off before its
/// finish, and gateway/unavailable responses. Anything else is reported to the user.
enum VoiceTranscriptionError: LocalizedError {
    case needsServer
    var errorDescription: String? { "Voice input needs the Impo server. Type your message instead." }
}

func isTransientNetworkError(_ error: any Error) -> Bool {
    if let url = error as? URLError { return url.code != .cancelled }
    if let stream = error as? StreamProtocolError { return stream == .incompleteStream }
    if let api = error as? InstantAPIError { return [502, 503, 504].contains(api.statusCode) }
    return false
}
