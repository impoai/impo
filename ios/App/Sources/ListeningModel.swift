import AVFoundation
import Foundation
import InstantClient
import Observation
import UIKit
import Network

@MainActor @Observable
final class ListeningModel: NSObject {
    var isRecording = false
    var isStarting = false
    var isSpeaking = false
    let meter = EchoMeterPresentation()
    var isFinishing = false
    var isListening: Bool { listeningSessionID != nil }
    private(set) var pauseReason: String?
    private(set) var pausedAt: Date?
    var wifiOnly = false {
        didSet {
            if let scope { UserDefaults.standard.set(wifiOnly, forKey: "instant.listening.wifiOnly.\(scope)") }
            if oldValue != wifiOnly {
                lastAutomaticAttempt = .distantPast
                if uploading { retrySyncOnCompletion = true }
                else { Task { [weak self] in await self?.sync(force: false) } }
            }
        }
    }
    var locationEnabled = true {
        didSet {
            if let scope { UserDefaults.standard.set(locationEnabled, forKey: "impo.echo.location.\(scope)") }
            if !locationEnabled { locationReader.stop() }
            else if isRecording { locationReader.start(requestPermission: isAppActive()) }
            locationStatus = locationReader.status
        }
    }
    var locationStatus = "Location is added while Echo records."
    var sealedBatchCount = 0
    var uploadStatus: String {
        if wifiOnly && network != .wifi { return "Waiting for Wi-Fi · recordings saved on this iPhone" }
        if network == .offline { return "Offline · recordings saved on this iPhone" }
        if uploading { return "Uploading · \(sealedBatchCount) batches remaining" }
        return wifiOnly ? "Wi-Fi only · syncs automatically" : "Wi-Fi and cellular · syncs about every 30 seconds"
    }
    var startedAt: Date?
    private(set) var echoSchedule = EchoSchedule()
    private(set) var echoScheduleLoaded = false
    private(set) var echoScheduleSaving = false
    private(set) var echoScheduleError: String?
    private(set) var scheduledStopAt: Date?
    @ObservationIgnored private var scheduleAnchor: Date?
    @ObservationIgnored private var scheduleStopTask: Task<Void, Never>?
    @ObservationIgnored private var scheduleRequest = UUID()
    @ObservationIgnored private var scheduleRefreshing = false
    @ObservationIgnored private var lastScheduleRefresh = Date.distantPast
    var notice: String?
    var uploadError: String?
    var loadError: String?
    var selectedDate = Date()
    var segments: [ListeningSegment] = []
    let timeline = EchoTimelineModel()
    var history: [ListeningSegment] = []
    var historyCursor: String?
    var historyLoaded = false
    var historyLoading = false
    var historyError: String?
    var historyNewerCursor: String?
    var historyDays: [ListeningDay] = []
    var historyCalendarError: String?
    var historyCalendarLoading = false
    var historyNavigationID = UUID()
    var historyBrowsingDate: String?
    @ObservationIgnored private var historyOperation: UUID?
    @ObservationIgnored private var calendarOperation: UUID?
    var activityNotice: String?
    var pending: [PendingRecording] = []
    var showIntroduction = false
    var hasConsent: Bool { scope.map { UserDefaults.standard.bool(forKey: "instant.listening.consent.\($0)") && UserDefaults.standard.bool(forKey: "impo.echo.locationExplained.\($0)") } ?? false }
    @ObservationIgnored private let locationReader: any EchoLocationReading
    @ObservationIgnored private let storageRoot: URL?
    @ObservationIgnored private var scope: String?
    @ObservationIgnored private var client: InstantClient?
    @ObservationIgnored private var store: ListeningStore?
    @ObservationIgnored private var capture: (any ListeningCaptureSession)?
    @ObservationIgnored private let captureFactory: (ListeningStore, @escaping @Sendable (ListeningCapture.Update) -> Void) -> any ListeningCaptureSession
    @ObservationIgnored private let requestPermission: () async -> Bool
    @ObservationIgnored private let isAppActive: () -> Bool
    @ObservationIgnored private var startAttempt = UUID()
    @ObservationIgnored private var automaticResumeAllowed = true
    @ObservationIgnored private var systemInterruptionActive = false
    @ObservationIgnored private var mediaServicesAvailable = true
    @ObservationIgnored private let resumeRetryDelays: [Duration]
    @ObservationIgnored private var preparation: Task<Void, Error>?
    @ObservationIgnored private var recovery: Task<Void, Never>?
    @ObservationIgnored private let networkMonitor = NWPathMonitor()
    @ObservationIgnored private var network = ListeningUploadPolicy.Network.offline
    @ObservationIgnored private var lastAutomaticAttempt = Date.distantPast
    @ObservationIgnored private var audioSetupTimedOut = false
    @ObservationIgnored private var deactivation: Task<Void, Never>?
    @ObservationIgnored private var startTask: Task<Void, Never>?
    @ObservationIgnored private var resumeRetry: Task<Void, Never>?
    @ObservationIgnored private let vad = ListeningVAD()
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var lastLogHeartbeat = Date.distantPast
    @ObservationIgnored private var uploading = false
    @ObservationIgnored private var retrySyncOnCompletion = false
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var captureGeneration = UUID()
    @ObservationIgnored private var retryRequested: Set<String> = []
    @ObservationIgnored private var deletedSegmentIDs: Set<String> = []
    @ObservationIgnored private let liveActivity = ListeningLiveActivity()
    private(set) var listeningSessionID: UUID?

    init(storageRoot: URL? = nil,
         captureFactory: @escaping (ListeningStore, @escaping @Sendable (ListeningCapture.Update) -> Void) -> any ListeningCaptureSession = { ListeningCapture(store: $0, update: $1) },
         requestPermission: @escaping () async -> Bool = { await AVAudioApplication.requestRecordPermission() },
         isAppActive: @escaping () -> Bool = { UIApplication.shared.applicationState == .active },
         locationReader: (any EchoLocationReading)? = nil,
         observeAudio: Bool = true, observeNetwork: Bool = true,
         resumeRetryDelays: [Duration] = [.seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(15), .seconds(30)]) {
        self.storageRoot = storageRoot
        self.captureFactory = captureFactory
        self.requestPermission = requestPermission
        self.isAppActive = isAppActive
        self.locationReader = locationReader ?? (storageRoot == nil ? EchoLocationReader() : UnavailableEchoLocationReader())
        self.resumeRetryDelays = resumeRetryDelays
        super.init()
        if storageRoot == nil { ListeningBackgroundUpload.shared.reconnect() }
        UIDevice.current.isBatteryMonitoringEnabled = true
        networkMonitor.pathUpdateHandler = { [weak self] path in
            let network: ListeningUploadPolicy.Network = path.status != .satisfied ? .offline : path.usesInterfaceType(.wifi) ? .wifi : .cellular
            Task { @MainActor [weak self] in self?.networkChanged(network) }
        }
        if observeNetwork { networkMonitor.start(queue: DispatchQueue(label: "ai.impo.listening.network")) }
        ListeningIntentBridge.model = self
        liveActivity.clearOrphans()
        if observeAudio { observeAudioSession() }
    }

    private func observeAudioSession() {
        if #available(iOS 27.0, *) {
            observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.didBecomeInactiveNotification, object: nil, queue: .main) { [weak self] notification in
                guard let context = notification.userInfo?[AVAudioSession.deactivationContextKey] as? AVAudioSession.DeactivationContext,
                      context.source == .system else { return } // Ignore our own stop/deactivation.
                Task { @MainActor [weak self] in self?.audioInterrupted() }
            })
            observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.resumptionRecommendationNotification, object: nil, queue: .main) { [weak self] notification in
                guard let context = notification.userInfo?[AVAudioSession.resumptionContextKey] as? AVAudioSession.ResumptionContext else { return }
                let shouldResume = context.recommendation == .shouldResume
                Task { @MainActor [weak self] in self?.audioInterruptionEnded(shouldResume: shouldResume) }
            })
        } else {
            observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
                let type = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
                let options = AVAudioSession.InterruptionOptions(rawValue: notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
                Task { @MainActor [weak self] in
                    if type == AVAudioSession.InterruptionType.began.rawValue { self?.audioInterrupted() }
                    else if type == AVAudioSession.InterruptionType.ended.rawValue { self?.audioInterruptionEnded(shouldResume: options.contains(.shouldResume)) }
                }
            })
        }
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] notification in
            let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            Task { @MainActor [weak self] in self?.audioRouteChanged(reason: reason) }
        })
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.mediaServicesWereLostNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.audioServicesLost() }
        })
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.audioServicesReset()
            }
        })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object:nil, queue:.main) { [weak self] _ in
            ListeningDiagnostics.shared.record("app.background")
            Task { @MainActor [weak self] in self?.capture?.setMeterForeground(false) }
        })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.resumeOnForeground() }
        })
    }

    func configure(scope newScope: String?, client: InstantClient?) {
        timeline.configure(scope: newScope, client: client)
        guard newScope != scope else { self.client = client; return }
        stop()
        generation = UUID(); scope = newScope; self.client = client; store = nil
        segments = []; pending = []; notice = nil; uploadError = nil; loadError = nil
        history = []; historyCursor = nil; historyLoaded = false; historyLoading = false; historyError = nil
        historyNewerCursor = nil; historyDays = []; historyCalendarError = nil; historyCalendarLoading = false
        historyOperation = nil; calendarOperation = nil; historyBrowsingDate = nil; historyNavigationID = UUID()
        deletedSegmentIDs = []; retryRequested = []
        echoSchedule = EchoSchedule(); echoScheduleLoaded = false; echoScheduleSaving = false; echoScheduleError = nil
        scheduleRequest = UUID(); scheduleRefreshing = false; lastScheduleRefresh = .distantPast
        guard let newScope else { wifiOnly = false; return }
        if let saved = UserDefaults.standard.data(forKey: "impo.echo.schedule.\(newScope)"),
           let schedule = try? JSONDecoder().decode(EchoSchedule.self, from: saved), schedule.isValid {
            echoSchedule = schedule
        }
        wifiOnly = UserDefaults.standard.bool(forKey: "instant.listening.wifiOnly.\(newScope)")
        locationEnabled = UserDefaults.standard.object(forKey: "impo.echo.location.\(newScope)") as? Bool ?? true
        do {
            let storage = try ListeningStore(scope: newScope, root: storageRoot)
            store = storage
            let token = generation
            let previousStop = deactivation
            recovery = Task { [weak self] in
                await previousStop?.value
                let error = await Task.detached { () -> String? in
                    do {
                        for var item in try storage.recordings() where item.streaming == true && !item.ready {
                            try ListeningSegmentWriter.finalize(&item, store: storage)
                        }
                        return nil
                    } catch { return "An interrupted recording is saved on this iPhone but couldn't be recovered yet." }
                }.value
                guard let self, token == self.generation else { return }
                if let error { self.uploadError = error }
                self.reloadPending()
            }
            // An OS termination cannot be resumed automatically. Recover finalized readable audio only.
            for var item in try storage.recordings() where !item.ready && item.streaming != true {
                if (item.requiresVAD == true || item.hasSpeech), let file = try? AVAudioFile(forReading: storage.audioURL(item.id)), file.length > 0 {
                    let duration = Double(file.length) / file.processingFormat.sampleRate
                    item.endedAt = item.startedAt.addingTimeInterval(min(duration, 600))
                    item.ready = true
                    try storage.save(item)
                } else { try storage.remove(item.id) }
                notice = "Echo stopped when the app closed. Tap Echo to start again."
            }
            reloadPending()
        } catch { notice = "Couldn't open saved recordings. Please restart Impo." }
    }

    func toggle() {
        if isListening || isStarting { stop(); return }
        if isFinishing { notice = "Finishing your last recording…"; return }
        guard client != nil, store != nil else { notice = "Sign in or connect your Impo server in Settings to use Echo."; return }
        if !hasConsent { showIntroduction = true; return }
        beginListening()
    }

    func refreshEchoSchedule(force: Bool = false) async {
        guard let client, !echoScheduleSaving, !scheduleRefreshing, force || Date().timeIntervalSince(lastScheduleRefresh) > 60 else { return }
        let owner = generation, request = UUID(); scheduleRequest = request; scheduleRefreshing = true; lastScheduleRefresh = Date()
        defer { if scheduleRequest == request { scheduleRefreshing = false } }
        do {
            let value = try await client.echoSchedule()
            guard owner == generation, scheduleRequest == request else { return }
            applyEchoSchedule(value); echoScheduleLoaded = true; echoScheduleError = nil
        } catch {
            guard owner == generation, scheduleRequest == request else { return }
            echoScheduleError = "Couldn't load your Echo schedule. Your last saved stop time still applies."
        }
    }

    func saveEchoSchedule(_ value: EchoSchedule) async throws {
        guard let client, !echoScheduleSaving else { throw InstantClientError.invalidResponse }
        let owner = generation; scheduleRequest = UUID(); scheduleRefreshing = false; echoScheduleSaving = true
        defer { if owner == generation { echoScheduleSaving = false } }
        let saved = try await client.saveEchoSchedule(value)
        guard owner == generation else { throw CancellationError() }
        applyEchoSchedule(saved); echoScheduleLoaded = true; echoScheduleError = nil
    }

    func applyEchoSchedule(_ value: EchoSchedule) {
        guard value.isValid else { return }
        echoSchedule = value
        if let scope, let encoded = try? JSONEncoder().encode(value) { UserDefaults.standard.set(encoded, forKey: "impo.echo.schedule.\(scope)") }
        scheduledStopAt = scheduleAnchor.flatMap { value.nextStop(after: $0) }
        armScheduledStop()
    }

    private func armScheduledStop() {
        scheduleStopTask?.cancel(); scheduleStopTask = nil
        guard isListening, let deadline = scheduledStopAt else { return }
        if checkScheduledStop() { return }
        let sessionID = listeningSessionID
        scheduleStopTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow))) } catch { return }
            guard let self, self.listeningSessionID == sessionID, self.scheduledStopAt == deadline else { return }
            if !self.checkScheduledStop() { self.armScheduledStop() } // Wall clock may have changed.
        }
    }

    @discardableResult func checkScheduledStop(now: Date = Date()) -> Bool {
        guard isListening, let deadline = scheduledStopAt, now >= deadline else { return false }
        stop(reason: "Echo stopped at your scheduled time.")
        return true
    }

    /// Account deletion discards this owner's queue; ordinary sign-out preserves it.
    func deleteLocalAccountData(scope deletedScope: String) async throws {
        if scope == deletedScope { configure(scope: nil, client: nil) }
        await deactivation?.value
        await recovery?.value
        let storage = try ListeningStore(scope: deletedScope, root: storageRoot)
        await ListeningBackgroundUpload.shared.cancelUploads(directory: storage.directory)
        if FileManager.default.fileExists(atPath: storage.directory.path) { try FileManager.default.removeItem(at: storage.directory) }
        for prefix in ["instant.listening.wifiOnly.", "instant.listening.consent.", "impo.echo.location.", "impo.echo.locationExplained.", "impo.echo.schedule."] {
            UserDefaults.standard.removeObject(forKey: prefix + deletedScope)
        }
    }

    func agreeAndStart() {
        if let scope {
            UserDefaults.standard.set(true, forKey: "instant.listening.consent.\(scope)")
            UserDefaults.standard.set(true, forKey: "impo.echo.locationExplained.\(scope)")
        }
        showIntroduction = false
        beginListening()
    }

    private func beginListening() {
        guard !isStarting, !isListening, !isFinishing, client != nil, store != nil, isAppActive() else { return }
        guard !audioSetupTimedOut else { notice = "The microphone isn't responding. Restart Impo and try again."; return }
        let attempt = UUID(); startAttempt = attempt
        isStarting = true; notice = nil
        startTask = Task { [weak self] in await self?.start(attempt: attempt) }
    }

    private func start(attempt: UUID) async {
        defer { if startAttempt == attempt { isStarting = false } }
        let allowed = await requestPermission()
        // A permission sheet may still be dismissing. Initial recording requires
        // the foreground; resuming an existing interrupted session does not.
        for _ in 0..<40 where !isAppActive() {
            try? await Task.sleep(for: .milliseconds(50))
            if startAttempt != attempt || Task.isCancelled { return }
        }
        guard startAttempt == attempt, !Task.isCancelled, isAppActive() else { return }
        guard allowed else { notice = "Microphone access is off. Enable it in iPhone Settings → Impo to start listening."; return }
        let sessionID = UUID(); listeningSessionID = sessionID
        startedAt = Date(); automaticResumeAllowed = true; systemInterruptionActive = false
        scheduleAnchor = startedAt; scheduledStopAt = scheduleAnchor.flatMap { echoSchedule.nextStop(after: $0) }; armScheduledStop()
        await prepareCapture(sessionID: sessionID, attempt: attempt, resuming: false)
    }

    /// Only called for a session the user has already started. A paused session
    /// retains its identity even while the system owns the microphone.
    func resume() {
        automaticResumeAllowed = true; systemInterruptionActive = false
        beginResume()
    }

    private func resumeAutomatically() {
        guard automaticResumeAllowed, !systemInterruptionActive, mediaServicesAvailable else { return }
        beginResume()
    }

    private func beginResume(retryIndex: Int = 0) {
        if checkScheduledStop() { return }
        guard isListening, !isRecording, !isStarting, let sessionID = listeningSessionID else { return }
        guard !audioSetupTimedOut else { pauseReason = "The microphone isn't responding. Restart Impo to continue."; return }
        automaticResumeAllowed = true
        resumeRetry?.cancel(); resumeRetry = nil
        let attempt = UUID(); startAttempt = attempt
        isStarting = true
        startTask = Task { [weak self] in
            guard let self else { return }
            await self.prepareCapture(sessionID: sessionID, attempt: attempt, resuming: true, retryIndex: retryIndex)
            if self.startAttempt == attempt { self.isStarting = false }
        }
    }

    private func prepareCapture(sessionID: UUID, attempt: UUID, resuming: Bool, retryIndex: Int = 0) async {
        do {
            await recovery?.value
            await deactivation?.value // Never overlap two engines or finish the old file after reactivation.
            try Task.checkCancellation()
            guard startAttempt == attempt, listeningSessionID == sessionID, let store else { return }
            if checkScheduledStop() { return }
            let captureToken = UUID(); captureGeneration = captureToken
            var captureStore = store; captureStore.sessionId = sessionID.uuidString.lowercased()
            locationReader.prepare()
            captureStore.locationHistory = locationReader.history
            log("capture.starting", ["resuming":String(resuming),"attempt":String(retryIndex)])
            let next = captureFactory(captureStore) { [weak self] update in
                Task { @MainActor [weak self] in
                    guard let self, self.captureGeneration == captureToken else { return }
                    switch update {
                    case .speech(let speaking): self.isSpeaking = speaking
                    case .meter(let levels):
                        guard self.isRecording else { return }
                        if self.meter.levels != levels { self.meter.levels = levels }
                        self.liveActivity.setWaveform(levels, isSpeaking: self.isSpeaking)
                    case .saved: self.reloadPending()
                    case .interrupted: self.audioInputChanged()
                    case .failed(let message): self.stop(reason: message)
                    }
                }
            }
            capture = next
            next.setMeterForeground(isAppActive())
            let preparing = Task.detached { try Task.checkCancellation(); try await next.start() }
            preparation = preparing
            try await listeningDeadline(preparing)
            // A delayed OS activation must not revive a stopped or interrupted attempt.
            guard startAttempt == attempt, listeningSessionID == sessionID, !Task.isCancelled else { return }
            if checkScheduledStop() { return }
            preparation = nil
            if !resuming && !isAppActive() { stop(); return }
            let now = Date()
            if let pausedAt, let startedAt { self.startedAt = startedAt.addingTimeInterval(now.timeIntervalSince(pausedAt)) }
            else if !resuming { startedAt = now }
            pausedAt = nil; pauseReason = nil; isRecording = true; notice = nil
            if locationEnabled { locationReader.start(requestPermission: !resuming && isAppActive()) }
            locationStatus = locationReader.status
            log("capture.started", ["resuming":String(resuming)])
            if liveActivity.activity == nil {
                activityNotice = liveActivity.start(sessionID: sessionID, startedAt: startedAt ?? now)
            } else { liveActivity.setRecording(true, startedAt: startedAt) }
            ensureHeartbeat()
        } catch {
            guard startAttempt == attempt, listeningSessionID == sessionID else { return }
            ListeningDiagnostics.shared.error("capture.start_failed", error, ["attempt":String(retryIndex),"resuming":String(resuming)])
            if (error as? URLError)?.code == .timedOut { audioSetupTimedOut = true }
            let message = audioSetupTimedOut ? "The microphone isn't responding. Restart Impo to continue."
                : "Microphone still unavailable. We'll retry when audio becomes available or you return to Impo."
            if resuming {
                pause(reason: message)
                if retryIndex < resumeRetryDelays.count, !audioSetupTimedOut {
                    // Audio may still be releasing when the resumption notification
                    // arrives. Bounded retries only; a new interruption or Stop cancels them.
                    let retryAttempt = startAttempt
                    let delay = resumeRetryDelays[retryIndex]
                    resumeRetry = Task { [weak self] in
                        do { try await Task.sleep(for: delay) } catch { return }
                        guard let self, self.startAttempt == retryAttempt, self.listeningSessionID == sessionID,
                              self.automaticResumeAllowed, !self.systemInterruptionActive, self.mediaServicesAvailable else { return }
                        self.beginResume(retryIndex: retryIndex + 1)
                    }
                }
            }
            else { stop(reason: "Couldn't start the microphone. Close other recording apps and try again.") }
        }
    }

    func audioInterrupted() {
        log("audio.interrupted")
        guard isListening else { return }
        automaticResumeAllowed = true; systemInterruptionActive = true
        pause(reason: "Audio interrupted. Resumes automatically when available.", deactivateSession: false)
    }

    func audioInterruptionEnded(shouldResume: Bool) {
        log("audio.interruption_ended", ["shouldResume":String(shouldResume)])
        guard isListening, !isRecording else { return }
        systemInterruptionActive = false
        automaticResumeAllowed = shouldResume
        if shouldResume { resumeAutomatically() }
        else { pause(reason: "Audio is available. Tap Resume to continue.", deactivateSession: false) }
    }

    func resumeOnForeground() {
        log("app.foreground")
        if checkScheduledStop() { return }
        capture?.setMeterForeground(true)
        guard automaticResumeAllowed else { return }
        // Foregrounding is the fallback for a missing end notification. A known
        // active system interruption still blocks route/watchdog-driven retries.
        systemInterruptionActive = false
        resumeAutomatically()
    }

    func audioInputChanged() {
        log("audio.input_changed")
        guard isListening, automaticResumeAllowed, !systemInterruptionActive, mediaServicesAvailable else { return }
        pause(reason: "Microphone changed. Reconnecting…")
        resumeAutomatically()
    }

    func audioRouteChanged(reason: UInt?) {
        log("audio.route_changed", ["reason":reason.map(String.init) ?? "unknown","route":AVAudioSession.sharedInstance().currentRoute.inputs.map { $0.portType.rawValue }.joined(separator:",")])
        guard let reason = reason.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:)),
              [.oldDeviceUnavailable, .newDeviceAvailable, .routeConfigurationChange].contains(reason) else { return }
        if isRecording && reason == .oldDeviceUnavailable { audioInputChanged() }
        else if !isStarting { resumeAutomatically() }
    }

    func audioServicesLost() {
        log("audio.services_lost")
        mediaServicesAvailable = false
        pause(reason: "Audio is temporarily unavailable. Waiting to reconnect…", deactivateSession: false)
    }

    func audioServicesReset() {
        log("audio.services_reset")
        mediaServicesAvailable = true
        systemInterruptionActive = false
        guard isListening else { return }
        pause(reason: "Audio restarted. Reconnecting…", deactivateSession: false)
        resumeAutomatically()
    }

    func checkCaptureHealth() {
        if checkScheduledStop() { return }
        locationStatus = locationReader.status
        diagnosticHeartbeat()
        if isRecording && capture?.isReceivingAudio == false { audioInputChanged() }
    }

    private func pause(reason: String, deactivateSession: Bool = true) {
        guard isListening else { return }
        if pausedAt == nil { pausedAt = Date() }
        pauseReason = reason
        haltCapture(deactivateSession: deactivateSession, syncAfter: false)
        liveActivity.setRecording(false, startedAt: startedAt)
        ensureHeartbeat()
    }

    private func ensureHeartbeat() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.isListening else { return }
                self.checkCaptureHealth()
                self.liveActivity.heartbeat()
            }
        }
    }

    private func haltCapture(deactivateSession: Bool, syncAfter: Bool) {
        locationReader.stop()
        locationStatus = locationReader.status
        startAttempt = UUID(); captureGeneration = UUID()
        resumeRetry?.cancel(); resumeRetry = nil
        startTask?.cancel(); preparation?.cancel()
        isStarting = false; isRecording = false; isSpeaking = false; meter.reset()
        let previous = capture; capture = nil
        let preparing = preparation; preparation = nil
        let token = generation
        guard let previous else { return }
        isFinishing = true
        // Without live mic input iOS may suspend us. Finish accepted audio under
        // a finite background task; resumption waits only for local finalization.
        let background = UIApplication.shared.beginBackgroundTask(withName: "Save interrupted speech")
        deactivation = Task { [weak self] in
            defer { if background != .invalid { UIApplication.shared.endBackgroundTask(background) } }
            _ = await preparing?.result
            // An in-flight OS activation may finish after the interruption. In
            // that case explicitly release it so a cancelled attempt owns no audio.
            let finishingError = await previous.stop(deactivateSession: deactivateSession || preparing != nil)
            guard let self else { return }
            self.isFinishing = false
            guard token == self.generation else { return }
            if let finishingError { self.notice = finishingError }
            self.reloadPending()
            if syncAfter { Task { await self.sync() } }
        }
    }

    func stop(reason: String? = nil) {
        log("capture.stop", ["reason":reason ?? "user"])
        let hadSession = isListening || isStarting || capture != nil
        listeningSessionID = nil; automaticResumeAllowed = false; systemInterruptionActive = false
        scheduleStopTask?.cancel(); scheduleStopTask = nil; scheduleAnchor = nil; scheduledStopAt = nil
        haltCapture(deactivateSession: true, syncAfter: true)
        timer?.invalidate(); timer = nil
        startedAt = nil; pausedAt = nil; pauseReason = nil
        activityNotice = nil; liveActivity.end()
        if hadSession, let reason { notice = reason }
    }

    func stopFromLiveActivity(sessionID: String) {
        // An old Lock Screen button must not stop a newer recording session.
        guard listeningSessionID?.uuidString == sessionID else { return }
        stop()
    }

    #if DEBUG
    /// UI/ActivityKit fixture only; never captures audio or pretends to test the microphone.
    func previewListeningActivity() {
        guard !isRecording else { return }
        startedAt = Date().addingTimeInterval(-65); isRecording = true
        let sessionID = UUID(); listeningSessionID = sessionID
        activityNotice = liveActivity.start(sessionID: sessionID, startedAt: startedAt!, isPreview: true)
        isSpeaking = !ProcessInfo.processInfo.arguments.contains("--preview-echo-quiet")
        meter.levels = isSpeaking ? [12, 24, 48, 80, 130, 185, 230, 196, 140, 92, 52, 28, 18, 38, 75, 126, 188, 248, 220, 178, 108, 60, 34, 68, 130, 205, 250, 210, 145, 82, 45, 24] : [UInt8](repeating: 0, count: 32)
        liveActivity.setWaveform(meter.levels, isSpeaking: isSpeaking)
        notice = "UI preview only · microphone is off."
    }
    #endif

    private func reloadPending() {
        do {
            pending = try store?.recordings().filter(\.ready) ?? []
            sealedBatchCount = try store.map { try ListeningBatchStore(store:$0).batches().count } ?? 0
        }
        catch { uploadError = "Couldn't read saved recordings. They remain on this iPhone." }
    }

    func networkChanged(_ newNetwork: ListeningUploadPolicy.Network) {
        let changed = network != newNetwork
        network = newNetwork
        if changed { log("network.changed", ["network":String(describing:newNetwork),"wifiOnly":String(wifiOnly)]) }
        guard changed, newNetwork != .offline else { return }
        // Reevaluate a saved queue as soon as connectivity returns. Batching and
        // Wi-Fi-only still apply, and this never changes microphone state.
        lastAutomaticAttempt = .distantPast
        if uploading { retrySyncOnCompletion = true; return }
        Task { [weak self] in await self?.sync(force: false) }
    }

    func sync(force: Bool = true) async {
        guard !uploading, let client, let store else { return }
        let entryToken = generation
        await recovery?.value
        guard entryToken == generation, !uploading else { return }
        uploading = true
        defer {
            uploading = false
            if retrySyncOnCompletion { retrySyncOnCompletion = false; Task { [weak self] in await self?.sync(force:false) } }
        }
        let token = generation
        let batches = ListeningBatchStore(store:store)
        let background = UIApplication.shared.beginBackgroundTask(withName:"Save and sync speech batches")
        defer { if background != .invalid { UIApplication.shared.endBackgroundTask(background) } }
        do {
            // Finish legacy local VAD before sealing, including while offline.
            for var item in try store.recordings() where item.ready && item.requiresVAD == true {
                if item.speechAnalysis == nil {
                    item.speechAnalysis = try await vad.analyze(url:store.audioURL(item.id))
                    guard generation == token, !Task.isCancelled else { return }
                    item.hasSpeech = item.speechAnalysis?.hasSpeech == true
                    try store.save(item)
                }
                if !item.hasSpeech { try store.remove(item.id); log("segment.no_speech", ["segmentId":item.id]) }
            }
            _ = try batches.seal(force:force)
            reloadPending(); diagnosticHeartbeat()
            if wifiOnly && network != .wifi { return }
            if !force {
                guard network != .offline, Date().timeIntervalSince(lastAutomaticAttempt) >= 3 else { return }
            }
            lastAutomaticAttempt = Date()
            for batch in try batches.batches() {
                guard generation == token, !Task.isCancelled else { return }
                if wifiOnly && network != .wifi { return }
                log("upload.started", ["batchId":batch.batchId,"sequence":String(batch.sequence),"segments":String(batch.segmentIDs.count),"bytes":String(batch.audioBytes)])
                do {
                    let legacyTransfer = storageRoot == nil ? await ListeningBackgroundUpload.shared.hasPendingBatch(batch.batchId, objectUpload: false) : false
                    if legacyTransfer {
                        // Adopt an old app version's already-running transfer before switching protocols.
                        var request = try await client.listeningBatchUploadRequest()
                        guard generation == token else { return }
                        request.allowsCellularAccess = !wifiOnly
                        try await ListeningBackgroundUpload.shared.uploadBatch(client:client,request:request,batch:batch,store:store)
                    } else if storageRoot == nil {
                        try await ListeningObjectUpload.sync(client: client, batch: batch, store: store, wifiOnly: wifiOnly) { request, file in
                            guard self.generation == token else { throw CancellationError() }
                            let pending = await ListeningBackgroundUpload.shared.hasPendingBatch(batch.batchId, objectUpload: true)
                            if pending || (!self.isAppActive() && !self.isRecording) {
                                try await ListeningBackgroundUpload.shared.uploadObject(request: request, batch: batch, store: store)
                            } else { try await ListeningObjectUpload.upload(request, file: file) }
                        }
                    } else {
                        // Isolated local protocol fixtures retain their deterministic HTTP transport.
                        let receipt = try await client.uploadListeningBatch(Data(contentsOf:batches.payloadURL(batch.batchId)), allowsCellularAccess: !wifiOnly)
                        try batches.verify(receipt,for:batch)
                        log("upload.receipt", ["batchId":batch.batchId,"sequence":String(batch.sequence),"status":"202"])
                    }
                } catch let error as InstantAPIError where error.statusCode == 410 { }
                try batches.removeConfirmed(batch)
                guard generation == token else { return }
                reloadPending()
            }
            if generation == token { uploadError = nil; reloadPending() }
        } catch {
            if generation == token, !Task.isCancelled {
                ListeningDiagnostics.shared.error("sync.deferred",error)
                uploadError = error is ListeningBatchError
                    ? "A recording exceeds the batch limit. It is saved on this iPhone; check Debug logs."
                    : "Audio is saved on this iPhone. Waiting to sync the next batch."
                reloadPending()
            }
        }
        if generation == token, historyLoaded { await refreshHistory(); await refreshHistoryCalendar() }
        if generation == token, timeline.loaded { await timeline.refresh() }
    }

    func retryBatch(_ id: String) async {
        do {
            try await client?.retryListeningBatch(id); retryRequested.insert(id); log("batch.retry_requested",["batchId":id])
            if historyLoaded { await refreshHistory() }
            timeline.poll(retrying: retryRequested)
        }
        catch { ListeningDiagnostics.shared.error("batch.retry_failed",error,["batchId":id]); loadError = "Couldn't request retry. Please try again." }
    }

    var diagnosticSummary: String {
        let receiving = capture?.isReceivingAudio == true
        return "Mic: \(isRecording ? (receiving ? "receiving audio" : "waiting for input") : isListening ? "paused" : "off")\nNetwork: \(network) · Wi-Fi only: \(wifiOnly)\nOn iPhone: \(pending.count) segments · \(sealedBatchCount) batches\n\(pauseReason ?? uploadError ?? "")"
    }
    func diagnosticHeartbeat() {
        guard Date().timeIntervalSince(lastLogHeartbeat) >= 60 else { return }
        lastLogHeartbeat = Date()
        log("health.heartbeat", ["receivingAudio":String(capture?.isReceivingAudio == true),"speaking":String(isSpeaking),"network":String(describing:network),"pending":String(pending.count),"batches":String(sealedBatchCount),"oldestSeconds":String(Int(pending.first.map { Date().timeIntervalSince($0.startedAt) } ?? 0)),"battery":String(UIDevice.current.batteryLevel),"charging":String(UIDevice.current.batteryState.rawValue)])
    }
    private func log(_ event: String, _ fields: [String:String] = [:]) {
        var fields = fields; fields["sessionId"] = listeningSessionID?.uuidString.lowercased() ?? "none"; fields["recording"] = String(isRecording)
        ListeningDiagnostics.shared.record(event,fields)
    }

    func pollTranscripts() async {
        retryRequested.subtract(timeline.records.values.filter { $0.status != "failed" }.compactMap(\.batchId))
        timeline.poll(retrying: retryRequested)
        if segments.contains(where: { $0.status == "pending" || $0.status == "transcribing" }) { await refresh() }
        if historyLoaded && (!retryRequested.isEmpty || history.contains(where: { $0.status == "pending" || $0.status == "transcribing" })) { await refreshHistory() }
    }

    func refreshHistoryCalendar() async {
        guard let client, !historyCalendarLoading else { return }
        let token = generation, operation = UUID(); calendarOperation = operation; historyCalendarLoading = true
        defer { if calendarOperation == operation { historyCalendarLoading = false } }
        do {
            let calendar = try await client.listeningCalendar(timeZone: TimeZone.current.identifier)
            guard token == generation, calendarOperation == operation, !Task.isCancelled else { return }
            historyDays = calendar.days; historyCalendarError = nil
        } catch {
            if token == generation, !Task.isCancelled, !Self.historyCancelled(error) { historyCalendarError = "Couldn't load the date index. Tap to retry." }
        }
    }

    func jumpHistory(to day: String? = nil) async {
        guard let client else { return }
        let token = generation, operation = UUID(); historyOperation = operation; historyLoading = true; historyError = nil
        defer { if historyOperation == operation { historyLoading = false } }
        do {
            let before = day.flatMap { EchoDates.date($0) }.flatMap { EchoDates.calendar.date(byAdding: .day, value: 1, to: $0) }
            let page = try await client.listeningHistory(before: before)
            guard token == generation, historyOperation == operation, !Task.isCancelled else { return }
            history = page.segments.filter { !deletedSegmentIDs.contains($0.id) }
            historyCursor = page.nextCursor; historyNewerCursor = page.previousCursor
            historyLoaded = true; historyBrowsingDate = day; historyNavigationID = UUID()
            ListeningDiagnostics.shared.record("echo.jump", ["records": String(history.count), "dated": String(day != nil)])
        } catch {
            if token == generation, historyOperation == operation, !Task.isCancelled, !Self.historyCancelled(error) { historyError = "Couldn't open this part of Echo. Try again." }
        }
    }

    func refreshHistory(reset: Bool = false) async {
        if reset { await jumpHistory(); await refreshHistoryCalendar(); return }
        guard !historyLoading, let client else { return }
        let token = generation, operation = UUID(); historyOperation = operation; historyLoading = true
        defer { if historyOperation == operation { historyLoading = false } }
        do {
            if historyNewerCursor != nil || historyBrowsingDate != nil {
                // Refresh the loaded window in place, including pending items away from the latest page.
                let ids = history.map(\.id)
                let updated = try await client.listeningRecords(ids: ids)
                guard token == generation, historyOperation == operation, !Task.isCancelled else { return }
                let returned = Set(updated.map(\.id))
                history.removeAll { !returned.contains($0.id) }; mergeHistory(updated)
            } else {
                let page = try await client.listeningHistory()
                guard token == generation, historyOperation == operation, !Task.isCancelled else { return }
                let incoming = page.segments.filter { !deletedSegmentIDs.contains($0.id) }
                let existingIDs = Set(history.map(\.id))
                let overlaps = incoming.contains { existingIDs.contains($0.id) }
                if !historyLoaded || page.nextCursor == nil || !overlaps {
                    history = incoming; historyCursor = page.nextCursor; historyNewerCursor = page.previousCursor
                } else { mergeHistory(incoming); trimHistory(keepingNewer: true) }
            }
            retryRequested.subtract(history.filter { $0.status != "failed" }.compactMap(\.batchId))
            historyLoaded = true; historyError = nil
        } catch {
            if token == generation, historyOperation == operation, !Task.isCancelled, !Self.historyCancelled(error) { historyError = "Couldn't refresh Echo. Pull down to try again." }
        }
    }

    func loadMoreHistory(newer: Bool = false) async {
        guard !historyLoading, let client, let cursor = newer ? historyNewerCursor : historyCursor else { return }
        let token = generation, operation = UUID(); historyOperation = operation; historyLoading = true
        defer { if historyOperation == operation { historyLoading = false } }
        do {
            let page = try await client.listeningHistory(cursor: cursor, newer: newer)
            guard token == generation, historyOperation == operation, !Task.isCancelled else { return }
            mergeHistory(page.segments)
            if newer { historyNewerCursor = page.previousCursor }
            else { historyCursor = page.nextCursor }
            trimHistory(keepingNewer: newer); historyError = nil
            ListeningDiagnostics.shared.record("echo.page", ["records": String(page.segments.count), "window": String(history.count), "direction": newer ? "newer" : "older"])
        } catch {
            if token == generation, historyOperation == operation, !Task.isCancelled, !Self.historyCancelled(error) { historyError = "Couldn't load more of Echo. Tap to retry." }
        }
    }

    private func trimHistory(keepingNewer: Bool) {
        // Keep only six pages of text; evicted rows stay reachable through server-issued cursors.
        guard history.count > 180 else { return }
        if keepingNewer, history[179].cursor != nil {
            history = Array(history.prefix(180)); historyCursor = history.last?.cursor
        } else if !keepingNewer, history[history.count - 180].cursor != nil {
            history = Array(history.suffix(180)); historyNewerCursor = history.first?.cursor
        }
    }

    private func mergeHistory(_ incoming: [ListeningSegment]) {
        let ids = Set(incoming.map(\.id))
        history = (incoming + history.filter { !ids.contains($0.id) }).filter { !deletedSegmentIDs.contains($0.id) }.sorted {
            $0.startedAt == $1.startedAt ? $0.id > $1.id : $0.startedAt > $1.startedAt
        }
    }

    private static func historyCancelled(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }

    func refresh() async {
        guard let client else { return }
        let token = generation
        let day = Calendar.current.startOfDay(for: selectedDate)
        guard let next = Calendar.current.date(byAdding: .day, value: 1, to: day) else { return }
        do {
            let result = try await client.listeningSegments(from: day, to: next)
            guard token == generation, Calendar.current.isDate(day, inSameDayAs: selectedDate) else { return }
            segments = result.filter { !deletedSegmentIDs.contains($0.id) }; loadError = nil
        } catch {
            if token == generation, !Task.isCancelled { loadError = "Couldn't load recordings. Pull down to try again." }
        }
    }

    func labelLocation(_ segment: ListeningSegment, label: String?) async throws -> ListeningSegment {
        guard let client else { throw URLError(.notConnectedToInternet) }
        let token = generation
        let updated = try await client.setListeningLocationLabel(segment.id, label: label)
        guard token == generation, !deletedSegmentIDs.contains(segment.id) else { throw CancellationError() }
        timeline.update(updated)
        if let index = history.firstIndex(where: { $0.id == updated.id }) { history[index] = updated }
        if let index = segments.firstIndex(where: { $0.id == updated.id }) { segments[index] = updated }
        return updated
    }

    @discardableResult func delete(_ segment: ListeningSegment) async -> Bool {
        guard let client else { return false }
        let token = generation
        do {
            try await client.deleteListeningSegment(segment.id)
            if token == generation {
                deletedSegmentIDs.insert(segment.id)
                timeline.remove(segment.id)
                segments.removeAll { $0.id == segment.id }; history.removeAll { $0.id == segment.id }
                await refreshHistoryCalendar()
            }
            return token == generation
        } catch { if token == generation { loadError = "Couldn't delete this recording. Please try again." }; return false }
    }
}
