import ActivityKit
import Foundation

struct ListeningActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var isRecording: Bool
        var checkedAt: Date
        var timerStartedAt: Date?
        var waveform: [UInt8]? = nil
        var isSpeaking: Bool? = nil
    }
    let sessionID: String
    let startedAt: Date
    let isPreview: Bool
}
