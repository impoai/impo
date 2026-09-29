@preconcurrency import ActivityKit
import Foundation

@MainActor
enum ListeningIntentBridge {
    static weak var model: ListeningModel?
}

@MainActor
final class ListeningLiveActivity {
    private(set) var activity: Activity<ListeningActivityAttributes>?
    private var lastUpdate = Date.distantPast
    private var isRecording = true
    private var timerStartedAt: Date?
    private var updateTask: Task<Void, Never>?
    private var levels = [UInt8](repeating: 0, count: 32)
    private var isSpeaking = false
    private var meterCadence = EchoActivityMeterCadence()
    private var meterUpdatePending = false
    private var publishedLevels = [UInt8](repeating: 0, count: 32)
    private var publishedSpeaking = false

    func start(sessionID: UUID, startedAt: Date, isPreview: Bool = false) -> String? {
        end()
        isRecording = true; timerStartedAt = startedAt
        levels = [UInt8](repeating: 0, count: 32); isSpeaking = false
        publishedLevels = levels; publishedSpeaking = false
        meterCadence = EchoActivityMeterCadence()
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            return "Live Activities are off. Enable them in iPhone Settings → Impo to see Echo on your Lock Screen."
        }
        do {
            activity = try Activity.request(attributes: ListeningActivityAttributes(
                sessionID: sessionID.uuidString, startedAt: startedAt, isPreview: isPreview),
                content: content(), pushType: nil)
            lastUpdate = Date()
            return nil
        } catch { return "Lock Screen status couldn't start. You can still stop Echo here in Impo." }
    }

    /// Timers are rendered by iOS; only liveness needs a periodic update.
    func heartbeat() {
        guard let activity, Date().timeIntervalSince(lastUpdate) >= 30 else { return }
        lastUpdate = Date()
        let update = content()
        enqueue(activity, content: update)
    }

    func setRecording(_ recording: Bool, startedAt: Date?) {
        isRecording = recording; timerStartedAt = startedAt
        if !recording { levels = [UInt8](repeating: 0, count: 32); isSpeaking = false }
        guard let activity else { return }
        lastUpdate = Date()
        enqueue(activity, content: content())
    }

    func setWaveform(_ levels: [UInt8], isSpeaking: Bool) {
        guard isRecording else { return }
        self.levels = Array(levels.suffix(32)); self.isSpeaking = isSpeaking
        guard let activity, !meterUpdatePending,
              self.levels != publishedLevels || isSpeaking != publishedSpeaking,
              meterCadence.shouldPublish(at: Date(), lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled) else { return }
        lastUpdate = Date(); meterUpdatePending = true
        publishedLevels = self.levels; publishedSpeaking = isSpeaking
        let previous = updateTask, snapshot = content()
        updateTask = Task {
            await previous?.value
            await activity.update(snapshot)
            meterUpdatePending = false
        }
    }

    private func enqueue(_ activity: Activity<ListeningActivityAttributes>, content: ActivityContent<ListeningActivityAttributes.ContentState>) {
        let previous = updateTask
        updateTask = Task { await previous?.value; await activity.update(content) }
    }

    func end() {
        guard let previous = activity else { return }
        activity = nil
        let updating = updateTask
        updateTask = Task { await updating?.value; await previous.end(nil, dismissalPolicy: .immediate) }
    }

    func clearOrphans() {
        let old = Activity<ListeningActivityAttributes>.activities
        Task { for activity in old { await activity.end(nil, dismissalPolicy: .immediate) } }
    }

    private func content() -> ActivityContent<ListeningActivityAttributes.ContentState> {
        ActivityContent(state: .init(isRecording: isRecording, checkedAt: Date(), timerStartedAt: timerStartedAt,
                                    waveform: levels, isSpeaking: isSpeaking),
                        staleDate: isRecording ? Date().addingTimeInterval(90) : nil)
    }
}
