import AppIntents
@preconcurrency import ActivityKit

/// LiveActivityIntent runs in the app process, where the actual recorder lives.
struct StopListeningIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Stop Echo recording"
    static let description = IntentDescription("Stop this recording and save its audio for transcription.")
    static let isDiscoverable: Bool = false

    @Parameter(title: "Echo session") var sessionID: String
    init() {}
    init(sessionID: String) { self.sessionID = sessionID }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if !LISTENING_WIDGET_EXTENSION
        ListeningIntentBridge.model?.stopFromLiveActivity(sessionID: sessionID)
        // Also clear an orphan activity if iOS previously terminated the recorder.
        for activity in Activity<ListeningActivityAttributes>.activities where activity.attributes.sessionID == sessionID {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        #endif
        return .result()
    }
}
