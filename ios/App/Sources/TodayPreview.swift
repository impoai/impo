#if DEBUG
import Foundation
import InstantClient

/// Explicit UI-test fixtures, never used by a signed-in production feed.
enum TodayPreview {
    static let briefs: [TodayBrief] = {
        let days = ["2026-09-28", "2026-09-27"]
        let rows: [[String: Any]] = days.enumerated().flatMap { day, date in
            ["evening", "morning"].enumerated().map { index, kind in
                let cards: [[String: Any]] = [
                    ["style": "plan", "eyebrow": "A little room to focus", "title": "Leave some space for the work that matters.", "body": "Your notes mention a project you want to finish this week. A short, uninterrupted window could help you take the next step.", "bullets": ["Choose one small outcome.", "Keep the next step close to your original notes."], "sourceIds": [], "links": []],
                    ["style": "reflection", "eyebrow": "Worth carrying forward", "title": "The small details are still here.", "body": "A brief is a place to return to what you noticed, without having to remember every conversation. Earlier editions stay in this timeline.", "bullets": [], "sourceIds": [], "links": []],
                    ["style": "discovery", "eyebrow": "For tomorrow", "title": "An open question, without an invented answer.", "body": "What would make tomorrow a little easier? Bring the question back to your conversation when you are ready.", "bullets": ["This is an explicit UI preview, not personal data."], "sourceIds": [], "links": []],
                ]
                return ["id": "preview-\(day)-\(index)", "localDate": date, "timeZone": "Asia/Shanghai", "kind": kind, "label": kind == "morning" ? "Morning Brief" : "Evening Brief", "scheduledAt": "\(date)T12:00:00Z", "createdAt": "\(date)T12:00:00Z", "completedAt": "\(date)T12:00:30Z", "status": "completed", "content": ["title": kind == "morning" ? "A thoughtful start to your day." : "A quieter moment to look back.", "summary": "Your briefs gather a few useful details from the information you choose to share. This screen uses preview content.", "cards": cards], "inputCutoff": "\(date)T12:00:00Z", "inputTruncated": false, "sources": []]
            }
        }
        return (try? JSONDecoder().decode([TodayBrief].self, from: JSONSerialization.data(withJSONObject: rows))) ?? []
    }()
}
#endif
