import SwiftUI
import InstantClient

struct EchoSpeakerTranscript: View {
    let segment: ListeningSegment
    let saved: (ListeningSegment) -> Void
    @Environment(ListeningModel.self) private var listening
    @State private var editing = false
    @State private var saving = false
    @State private var error: String?
    private var review: EchoSpeakerReview { segment.speakerReview ?? .init() }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            if !segment.speakerIDs.isEmpty, segment.speakerReview != nil {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(review.status == "confirmed" ? "Your voice is selected" : review.status == "not_present" ? "You are not in this recording" : "Which voice is yours?")
                            .font(.headline)
                        Spacer(minLength: 8)
                        Button(review.status == "unconfirmed" ? "Choose" : "Change") { editing = true }
                            .frame(minHeight: 44).accessibilityIdentifier("echo.speakers.edit")
                    }
                    Text(review.status == "confirmed"
                         ? "Only your selected speech can be used in memories and Brief. You can exclude individual passages below."
                         : "This Echo is not used in memories or Brief until you confirm your voice.")
                        .font(.footnote).foregroundStyle(InstantStyle.muted)
                    Text("Speaker labels apply only to this recording. The full transcript stays in Echo.")
                        .font(.caption).foregroundStyle(InstantStyle.muted)
                }.padding(16).background(InstantStyle.forest.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
            }
            if let error { Text(error).font(.footnote).foregroundStyle(InstantStyle.accent).accessibilityIdentifier("echo.speakers.error") }
            if let turns = segment.utterances, !turns.isEmpty {
                ForEach(turns) { turn in
                    let isSelf = review.status == "confirmed" && turn.speaker.map { review.selfSpeakerIds.contains($0) } == true
                    let included = review.includes(turn)
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Label(segment.speakerLabel(turn.speaker) + (isSelf ? " · You" : ""), systemImage: isSelf ? "person.crop.circle.fill" : "person.crop.circle")
                                .font(.subheadline.weight(.semibold)).foregroundStyle(isSelf ? InstantStyle.forest : InstantStyle.muted)
                            Spacer(minLength: 8)
                            if isSelf {
                                Button(included ? "Exclude" : "Include") { exclude(turn, included: included) }
                                    .font(.caption).frame(minHeight: 44)
                                    .accessibilityLabel("\(included ? "Exclude" : "Include") passage \(turn.id) in personal memories")
                                    .accessibilityIdentifier("echo.speakers.\(turn.id).toggle")
                            }
                        }
                        Text(turn.text).font(.system(size: 18)).lineSpacing(7).textSelection(.enabled)
                        if isSelf && !included { Text("Excluded from memories and Brief").font(.caption).foregroundStyle(InstantStyle.muted) }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                Text(segment.displayTranscript).font(.system(size: 18)).lineSpacing(7).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("listening.full-transcript")
                if segment.status == "transcribed", !segment.transcript.isEmpty {
                    Text(segment.speakerReview == nil ? "Speaker labels are not available for this recording."
                         : "Speaker labels are not available. This Echo is not used in memories or Brief.")
                        .font(.footnote).foregroundStyle(InstantStyle.muted)
                }
            }
        }.disabled(saving)
            .sheet(isPresented: $editing) { EchoSpeakerEditor(segment: segment, saved: saved).swipeToDismiss() }
    }

    private func exclude(_ turn: EchoUtterance, included: Bool) {
        var value = review
        if included { value.excludedUtteranceIds.append(turn.id) }
        else { value.excludedUtteranceIds.removeAll { $0 == turn.id } }
        saving = true; error = nil
        Task {
            defer { saving = false }
            do { saved(try await listening.reviewSpeakers(segment, review: value)) }
            catch is CancellationError { }
            catch {
                await listening.refreshRecording(segment.id)
                self.error = "Couldn't save this change. The recording has been refreshed; please try again."
            }
        }
    }
}

struct EchoSpeakerEditor: View {
    let segment: ListeningSegment
    let saved: (ListeningSegment) -> Void
    @Environment(ListeningModel.self) private var listening
    @Environment(\.dismiss) private var dismiss
    @State private var review: EchoSpeakerReview
    @State private var saving = false
    @State private var error: String?
    @State private var needsRefresh = false

    init(segment: ListeningSegment, saved: @escaping (ListeningSegment) -> Void) {
        self.segment = segment; self.saved = saved
        _review = State(initialValue: segment.speakerReview ?? .init())
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Speaker labels can be wrong. Check the passages before choosing your voice. If your voice was split into more than one speaker, select each one.")
                        .foregroundStyle(InstantStyle.muted)
                    ForEach(Array(segment.speakerIDs.enumerated()), id: \.element) { index, speaker in
                        let selected = review.status == "confirmed" && review.selfSpeakerIds.contains(speaker)
                        Button {
                            if selected { review.selfSpeakerIds.removeAll { $0 == speaker } }
                            else { review.selfSpeakerIds.append(speaker) }
                            review.status = review.selfSpeakerIds.isEmpty ? "unconfirmed" : "confirmed"
                            if review.status != "confirmed" { review.excludedUtteranceIds = [] }
                        } label: {
                            VStack(alignment: .leading, spacing: 10) {
                                HStack {
                                    Text(segment.speakerLabel(speaker)).font(.headline)
                                    Spacer()
                                    Label(selected ? "This is me" : "Select", systemImage: selected ? "checkmark.circle.fill" : "circle")
                                        .font(.subheadline)
                                }
                                ForEach(Array((segment.utterances ?? []).filter { $0.speaker == speaker }.prefix(2))) { turn in
                                    Text(turn.text).font(.body).lineLimit(4).multilineTextAlignment(.leading)
                                }
                            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                                .background(InstantStyle.forest.opacity(selected ? 0.12 : 0.04), in: RoundedRectangle(cornerRadius: 14))
                        }.buttonStyle(.plain).accessibilityIdentifier("echo.speakers.option.\(index)")
                            .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                    choice("Not sure", status: "unconfirmed", identifier: "unknown")
                    choice("None of these is me", status: "not_present", identifier: "none")
                    Text("Only confirmed speech is eligible for personal memories and Brief. Changing your choice withdraws memories and Briefs that relied on the previous choice. The full transcript remains in Echo.")
                        .font(.footnote).foregroundStyle(InstantStyle.muted)
                    if let error { Text(error).font(.footnote).foregroundStyle(InstantStyle.accent).accessibilityIdentifier("echo.speakers.error") }
                }.padding(24).disabled(saving || needsRefresh)
            }.background(InstantStyle.paper)
                .navigationTitle("Your voice").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(saving ? "Saving…" : "Save") {
                            saving = true; error = nil
                            Task {
                                defer { saving = false }
                                do { saved(try await listening.reviewSpeakers(segment, review: review)); dismiss() }
                                catch is CancellationError { dismiss() }
                                catch {
                                    await listening.refreshRecording(segment.id)
                                    needsRefresh = true
                                    self.error = "Couldn't save your choice. Close this sheet and try again with the refreshed recording."
                                }
                            }
                        }.disabled(saving || needsRefresh).accessibilityIdentifier("echo.speakers.save")
                    }
                }
        }.tint(InstantStyle.forest).interactiveDismissDisabled(saving)
    }
    private func choice(_ title: String, status: String, identifier: String) -> some View {
        Button {
            review.status = status; review.selfSpeakerIds = []; review.excludedUtteranceIds = []
        } label: {
            Label(title, systemImage: review.status == status ? "checkmark.circle.fill" : "circle")
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }.accessibilityIdentifier("echo.speakers.\(identifier)")
    }
}
