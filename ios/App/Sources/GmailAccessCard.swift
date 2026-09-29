import SwiftUI
import SafariServices

struct GmailAccessCard: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var gmail = model.gmail
        VStack(alignment: .leading, spacing: 13) {
            HStack(spacing: 12) {
                Image(systemName: "envelope.fill").font(.system(size: 22)).foregroundStyle(InstantStyle.accent)
                    .frame(width: 42, height: 42)
                    .background(InstantStyle.paperElevated, in: RoundedRectangle(cornerRadius: 11))
                    .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(InstantStyle.border, lineWidth: 0.75))
                Text("Gmail").font(InstantStyle.serif(20))
                Spacer()
                if gmail.isBusy { ProgressView().controlSize(.small).tint(InstantStyle.forest) }
            }
            Text("Find emails and compose Gmail drafts when you ask.")
                .font(.system(size: 14)).foregroundStyle(InstantStyle.muted).lineSpacing(3)
            Text(gmail.statusText).font(.caption).foregroundStyle(InstantStyle.forest)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(InstantStyle.sage.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityIdentifier("connection.gmail.status")
            if gmail.isAvailable {
                HStack(spacing: 18) {
                    if gmail.connection?.status != .connected {
                        Button(gmail.connection?.status == .expired ? "Reconnect" : "Connect") { gmail.connect() }
                            .font(.system(size: 15, weight: .medium)).foregroundStyle(InstantStyle.forest)
                            .padding(.horizontal, 18).padding(.vertical, 10).frame(minHeight: 44)
                            .instantGlass(cornerRadius: 13, tint: InstantStyle.accent.opacity(0.24))
                            .accessibilityIdentifier("connection.gmail")
                    }
                    Button("Refresh") { gmail.refreshStatus(checkAuthorization: true) }
                        .font(.footnote).foregroundStyle(InstantStyle.muted)
                        .accessibilityIdentifier("connection.gmail.refresh")
                    if gmail.connection?.status == .connected || gmail.connection?.status == .pending || gmail.awaitingAuthorization {
                        Button("Disconnect") { gmail.disconnect() }
                            .font(.footnote).foregroundStyle(InstantStyle.muted)
                            .accessibilityIdentifier("connection.gmail.disconnect")
                    }
                }.buttonStyle(.plain).disabled(gmail.isBusy)
                Text("Authorize in the secure browser, then return here. Your account is connected only after the server verifies it. Relevant email content is sent to Impo and its AI service when you ask.")
                    .font(.caption).foregroundStyle(InstantStyle.muted).lineSpacing(2)
            } else {
                Text("Gmail is unavailable in offline Demo. Enable your local server in Settings → Development, then return to connect.")
                    .font(.caption).foregroundStyle(InstantStyle.muted).lineSpacing(2)
                    .accessibilityIdentifier("connection.gmail.offline")
            }
            if let error = gmail.error {
                Text(error).font(.caption).foregroundStyle(InstantStyle.muted)
                    .accessibilityIdentifier("connection.gmail.error")
            }
        }
        .foregroundStyle(InstantStyle.ink)
        .padding(20).frame(maxWidth: .infinity, alignment: .leading)
        .paperSurface(cornerRadius: 18)
        .sheet(item: $gmail.authorization, onDismiss: { gmail.refreshStatus(checkAuthorization: true) }) { authorization in
            GmailAuthorizationSheet(url: authorization.url).ignoresSafeArea().swipeToDismiss()
        }
    }
}

private struct GmailAuthorizationSheet: UIViewControllerRepresentable {
    @Environment(\.dismiss) private var dismiss
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(onDismiss: { dismiss() }) }
    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.delegate = context.coordinator
        controller.dismissButtonStyle = .done
        controller.preferredBarTintColor = UIColor(InstantStyle.paperElevated)
        controller.preferredControlTintColor = UIColor(InstantStyle.forest)
        return controller
    }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}

    final class Coordinator: NSObject, SFSafariViewControllerDelegate {
        let onDismiss: () -> Void
        init(onDismiss: @escaping () -> Void) { self.onDismiss = onDismiss }
        func safariViewControllerDidFinish(_ controller: SFSafariViewController) { onDismiss() }
    }
}
