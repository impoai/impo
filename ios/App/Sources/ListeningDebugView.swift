import SwiftUI

struct ListeningDebugView: View {
    @Environment(ListeningModel.self) private var listening
    @Environment(\.dismiss) private var dismiss
    @State private var logs = "Loading…"
    @State private var filter = ""
    @State private var exportURL: URL?
    @State private var error: String?
    private var visible: String {
        logs.split(separator:"\n").filter { filter.isEmpty || $0.localizedCaseInsensitiveContains(filter) }.reversed().joined(separator:"\n\n")
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading,spacing:18) {
                    Text(listening.diagnosticSummary).font(.system(.subheadline,design:.monospaced)).textSelection(.enabled)
                        .accessibilityIdentifier("listening.debug-status")
                    Text("Logs stay on this iPhone for up to 7 days (20 MB). Audio, transcripts and sign-in tokens are excluded. Export after testing to diagnose interruptions and batch uploads.")
                        .font(.footnote).foregroundStyle(InstantStyle.muted)
                    HStack {
                        Button("Refresh") { Task { await refresh() } }
                        Spacer()
                        Button("Prepare export") { Task {
                            do { exportURL = try await ListeningDiagnostics.shared.export(); error = nil }
                            catch { self.error = "Couldn't export logs. Please try again." }
                        } }.accessibilityIdentifier("listening.debug-export")
                    }
                    if let exportURL { ShareLink("Share logs",item:exportURL).accessibilityIdentifier("listening.debug-share") }
                    if let error { Text(error).font(.footnote) }
                    TextField("Filter by event or batch ID",text:$filter).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .padding(12).paperSurface(cornerRadius:12)
                    Text("Latest 500 events · newest first").font(.caption).foregroundStyle(InstantStyle.muted)
                    Text(visible.isEmpty ? "No matching events." : visible).font(.system(size:11,design:.monospaced))
                        .textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading).accessibilityIdentifier("listening.debug-logs")
                }.padding(20)
            }.background(InstantStyle.paper).navigationTitle("Echo Debug").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement:.topBarTrailing) { Button("Done") { dismiss() } } }
                .task { await refresh() }
        }.tint(InstantStyle.forest)
    }
    private func refresh() async {
        listening.diagnosticHeartbeat()
        do { logs = try await ListeningDiagnostics.shared.read(); error = nil }
        catch { self.error = "Couldn't read diagnostic logs." }
    }
}
