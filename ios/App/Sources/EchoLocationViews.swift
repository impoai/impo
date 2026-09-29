import SwiftUI
import InstantClient

extension EchoLocationSpan {
    var placeLabel: String { [district, city].compactMap { $0 }.joined(separator: ", ") }
    var timeLabel: String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let start = formatter.date(from: from) ?? ISO8601DateFormatter().date(from: from),
              let end = formatter.date(from: to) ?? ISO8601DateFormatter().date(from: to) else { return "Recording time" }
        let first = start.formatted(date: .omitted, time: .shortened), last = end.formatted(date: .omitted, time: .shortened)
        return first == last ? first : "\(first) – \(last)"
    }
}

extension EchoLocationContext {
    /// nil when there is nothing to say: missing location is simply not shown.
    var displayLabel: String? {
        if let label, !label.isEmpty { return label }
        let places = Set(spans.map { $0.placeLabel + ", " + $0.country })
        if places.count > 1 { return "Multiple locations" }
        return spans.first.map { "Near \($0.placeLabel)" }
    }
    /// One entry per stay: consecutive samples of the same area merge even across pauses in speech.
    var displaySpans: [EchoLocationSpan] {
        var result: [EchoLocationSpan] = []
        for span in spans {
            if let last = result.last, last.placeLabel == span.placeLabel, last.country == span.country {
                result[result.count - 1] = EchoLocationSpan(from: last.from, to: span.to, capturedAt: last.capturedAt,
                    accuracyMeters: max(last.accuracyMeters, span.accuracyMeters), granularity: span.granularity,
                    city: span.city, country: span.country, district: span.district)
            } else { result.append(span) }
        }
        return result
    }
}

struct EchoLocationSettings: View {
    @Environment(ListeningModel.self) private var listening
    @Environment(\.openURL) private var openURL
    var body: some View {
        @Bindable var listening = listening
        Toggle("Add location to Echo", isOn: $listening.locationEnabled)
            .accessibilityIdentifier("echo.location.enabled")
        Text("Adds the city or area where you record, including while your iPhone is locked. Stops when recording stops. Coordinates are not sent to Impo.")
            .font(.footnote).foregroundStyle(InstantStyle.muted)
        if listening.locationEnabled, !listening.locationStatus.isEmpty {
            Text(listening.locationStatus).font(.footnote).foregroundStyle(InstantStyle.muted)
                .accessibilityIdentifier("echo.location.status")
            Button("Location permission settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            }
        }
    }
}

struct EchoLocationDetail: View {
    let location: EchoLocationContext?
    let edit: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                if let text = location?.displayLabel {
                    Label(text, systemImage: "mappin.and.ellipse")
                        .accessibilityIdentifier("echo.detail.location")
                }
                Spacer(minLength: 12)
                Button(location?.label == nil ? (location?.displayLabel == nil ? "Add location" : "Add label") : "Edit label", action: edit)
                    .accessibilityIdentifier("echo.location.edit")
            }
            if location?.label != nil { Text("Your label").font(.caption).foregroundStyle(InstantStyle.muted) }
            // A single place is already the heading; list stays only when there is more to tell.
            if let spans = location?.displaySpans, spans.count > 1 || (location?.label != nil && !spans.isEmpty) {
                ForEach(Array(spans.enumerated()), id: \.offset) { _, span in
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Near \(span.placeLabel), \(span.country)")
                        Text(span.timeLabel).font(.caption).foregroundStyle(InstantStyle.muted)
                    }
                }
            }
        }.font(.subheadline)
    }
}

struct EchoLocationLabelEditor: View {
    let segment: ListeningSegment
    let saved: (ListeningSegment) -> Void
    @Environment(ListeningModel.self) private var listening
    @Environment(\.dismiss) private var dismiss
    @State private var label: String
    @State private var saving = false
    @State private var error: String?
    init(segment: ListeningSegment, saved: @escaping (ListeningSegment) -> Void) {
        self.segment = segment; self.saved = saved
        _label = State(initialValue: segment.location?.label ?? "")
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Home, Office, or another place", text: $label)
                        .accessibilityIdentifier("echo.location.label")
                    HStack {
                        ForEach(["Home", "Office"], id: \.self) { suggestion in
                            Button(suggestion) { label = suggestion }.buttonStyle(.bordered)
                        }
                    }
                } header: { Text("Your location label") }
                  footer: { Text("This is your annotation. Device location and transcript text stay unchanged. Leave blank to remove the label.") }
                if let error { Text(error).foregroundStyle(InstantStyle.accent) }
            }.scrollContentBackground(.hidden).background(InstantStyle.paper)
                .navigationTitle("Location label").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(saving ? "Saving…" : "Save") {
                            saving = true; error = nil
                            Task {
                                defer { saving = false }
                                do {
                                    let value = label.trimmingCharacters(in: .whitespacesAndNewlines)
                                    let updated = try await listening.labelLocation(segment, label: value.isEmpty ? nil : value)
                                    saved(updated); dismiss()
                                } catch is CancellationError { dismiss() }
                                catch { self.error = "Couldn't save this label. Please try again." }
                            }
                        }.disabled(saving || label.utf16.count > 80 || label.rangeOfCharacter(from: .controlCharacters) != nil)
                            .accessibilityIdentifier("echo.location.save")
                    }
                }
        }.tint(InstantStyle.forest).interactiveDismissDisabled(saving)
    }
}
