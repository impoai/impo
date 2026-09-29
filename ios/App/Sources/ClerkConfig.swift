import Foundation

/// Configuration is supplied by the app's local xcconfig, never by checked-in credentials.
enum ClerkConfig {
    static let publishableKey: String = {
        #if DEBUG
        value("ImpoClerkKeyDebug")
        #else
        value("ImpoClerkKeyRelease")
        #endif
    }()
    static var isConfigured: Bool { !publishableKey.isEmpty }
    static let apiBaseURL = value("ImpoAPIBaseURL").isEmpty ? "https://api.example.invalid" : value("ImpoAPIBaseURL")
    private static func value(_ key: String) -> String {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !value.contains("$(") else { return "" }
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
