import SwiftUI
import SafariServices
import InstantClient

/// External apps from the server's connector shelf: what is connected, a few suggestions,
/// and a searchable directory of everything else.
struct ConnectorsSection: View {
    @Environment(AppModel.self) private var model
    @State private var selected: ConnectorSummary?
    @State private var browsing = false

    var body: some View {
        let connectors = model.connectors
        VStack(alignment: .leading, spacing: 12) {
            Label("Apps", systemImage: "square.grid.2x2.fill").font(InstantStyle.serif(21)).padding(.top, 8)
            if !connectors.isAvailable {
                Text("Apps are unavailable in offline Demo. Enable your local server in Settings → Development, then return to connect.")
                    .font(.caption).foregroundStyle(InstantStyle.muted).lineSpacing(2)
                    .accessibilityIdentifier("connection.apps.offline")
            } else if !connectors.loaded {
                if connectors.isBusy {
                    HStack(spacing: 10) { ProgressView().controlSize(.small).tint(InstantStyle.forest); Text("Loading apps…").font(.footnote).foregroundStyle(InstantStyle.muted) }
                } else {
                    Button("Try again") { connectors.reload() }
                        .font(.footnote.weight(.medium)).foregroundStyle(InstantStyle.forest).frame(minHeight: 44)
                        .accessibilityIdentifier("connection.apps.retry")
                }
            } else {
                Text("Connect an account and ask Impo to work in it for you.")
                    .font(.system(size: 14)).foregroundStyle(InstantStyle.muted).lineSpacing(3)
                if !connectors.active.isEmpty {
                    ConnectorList(items: connectors.active) { selected = $0 }
                }
                if !connectors.suggested.isEmpty {
                    Text("Suggested").font(.footnote.weight(.semibold)).foregroundStyle(InstantStyle.muted).padding(.top, 4)
                    ConnectorList(items: connectors.suggested) { selected = $0 }
                }
                Button { browsing = true } label: {
                    HStack {
                        Text("Browse all \(connectors.connectors.count) apps").font(.system(size: 15, weight: .medium))
                        Spacer()
                        Image(systemName: "magnifyingglass")
                    }.foregroundStyle(InstantStyle.forest).padding(.horizontal, 16).frame(minHeight: 48)
                    .instantGlass(cornerRadius: 13, tint: InstantStyle.accent.opacity(0.18))
                }.buttonStyle(.plain).accessibilityIdentifier("connection.apps.browse")
            }
            if let error = connectors.error, connectors.errorToolkit == nil {
                Text(error).font(.caption).foregroundStyle(InstantStyle.muted).accessibilityIdentifier("connection.apps.error")
            }
        }
        .sheet(item: $selected) { ConnectorDetailSheet(toolkit: $0.toolkit) }
        .sheet(isPresented: $browsing) { ConnectorDirectorySheet() }
    }
}

private struct ConnectorList: View {
    let items: [ConnectorSummary]
    let open: (ConnectorSummary) -> Void
    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 { Divider().overlay(InstantStyle.border.opacity(0.6)).padding(.leading, 60) }
                ConnectorRow(connector: item) { open(item) }
            }
        }.paperSurface(cornerRadius: 16)
    }
}

private struct ConnectorRow: View {
    @Environment(AppModel.self) private var model
    let connector: ConnectorSummary
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                ConnectorLogo(connector: connector, size: 34)
                VStack(alignment: .leading, spacing: 2) {
                    Text(connector.name).font(.system(size: 16, weight: .medium)).foregroundStyle(InstantStyle.ink)
                    if connector.status != .disconnected || model.connectors.awaitingToolkit == connector.toolkit {
                        Text(model.connectors.statusText(connector.toolkit)).font(.caption).foregroundStyle(connector.status == .connected ? InstantStyle.forest : InstantStyle.muted)
                    } else if let description = connector.description {
                        Text(description).font(.caption).foregroundStyle(InstantStyle.muted).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if model.connectors.busyToolkit == connector.toolkit { ProgressView().controlSize(.small).tint(InstantStyle.forest) }
                else if connector.status == .connected { Image(systemName: "checkmark.circle.fill").foregroundStyle(InstantStyle.forest) }
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(InstantStyle.muted)
            }.padding(.horizontal, 14).frame(minHeight: 58).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("connector.\(connector.toolkit)")
    }
}

struct ConnectorLogo: View {
    let connector: ConnectorSummary
    let size: CGFloat
    var body: some View {
        let url = connector.logoURL.flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil }
        AsyncImage(url: url) { phase in
            if let image = phase.image { image.resizable().scaledToFit().padding(size * 0.14) }
            else { Text(connector.name.prefix(1).uppercased()).font(.system(size: size * 0.45, weight: .semibold)).foregroundStyle(InstantStyle.forest) }
        }
        .frame(width: size, height: size)
        .background(InstantStyle.paperElevated, in: RoundedRectangle(cornerRadius: size * 0.26))
        .overlay(RoundedRectangle(cornerRadius: size * 0.26).strokeBorder(InstantStyle.border, lineWidth: 0.75))
        .accessibilityHidden(true)
    }
}

private struct ConnectorDirectorySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var selected: ConnectorSummary?
    var body: some View {
        let results = model.connectors.search(query)
        ZStack {
            InstantBackground()
            VStack(spacing: 12) {
                HStack {
                    Text("All apps").font(InstantStyle.serif(24))
                    Spacer()
                    Button("Done") { dismiss() }.font(.system(size: 15, weight: .medium)).foregroundStyle(InstantStyle.forest).frame(minHeight: 44)
                }.padding(.horizontal, 18)
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(InstantStyle.muted)
                    TextField("Search apps", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("connection.apps.search")
                }.padding(.horizontal, 14).frame(minHeight: 44).paperSurface(cornerRadius: 13).padding(.horizontal, 18)
                ScrollView {
                    if results.isEmpty {
                        Text("No apps match “\(query)”.").font(.footnote).foregroundStyle(InstantStyle.muted).padding(.top, 24)
                    } else {
                        ConnectorList(items: results) { selected = $0 }.padding(.horizontal, 18).padding(.bottom, 35)
                    }
                }.scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively)
            }.padding(.top, 18)
        }
        .foregroundStyle(InstantStyle.ink).presentationDragIndicator(.visible)
        .sheet(item: $selected) { ConnectorDetailSheet(toolkit: $0.toolkit) }
    }
}

struct ConnectorDetailSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let toolkit: String

    var body: some View {
        @Bindable var connectors = model.connectors
        let connector = connectors.connector(toolkit)
        let name = connector?.name ?? toolkit
        let status = connector?.status
        let busy = connectors.busyToolkit == toolkit
        ZStack {
            InstantBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 12) {
                        if let connector { ConnectorLogo(connector: connector, size: 46) }
                        Text(name).font(InstantStyle.serif(24))
                        Spacer()
                        if busy { ProgressView().controlSize(.small).tint(InstantStyle.forest) }
                        Button { dismiss() } label: { Image(systemName: "xmark").font(.system(size: 15, weight: .semibold)).frame(width: 44, height: 44) }
                            .foregroundStyle(InstantStyle.muted).accessibilityLabel("Close")
                    }
                    if let description = connector?.description {
                        Text(description).font(.system(size: 14)).foregroundStyle(InstantStyle.muted).lineSpacing(3)
                    }
                    Text(connectors.statusText(toolkit)).font(.caption).foregroundStyle(InstantStyle.forest)
                        .padding(.horizontal, 10).padding(.vertical, 7)
                        .background(InstantStyle.sage.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
                        .accessibilityIdentifier("connection.\(toolkit).status")
                    if connectors.isAvailable {
                        HStack(spacing: 18) {
                            if status != .connected {
                                Button(status == .expired ? "Reconnect" : "Connect") { connectors.connect(toolkit) }
                                    .font(.system(size: 15, weight: .medium)).foregroundStyle(InstantStyle.forest)
                                    .padding(.horizontal, 18).padding(.vertical, 10).frame(minHeight: 44)
                                    .instantGlass(cornerRadius: 13, tint: InstantStyle.accent.opacity(0.24))
                                    .accessibilityIdentifier("connection.\(toolkit)")
                            }
                            Button("Refresh") { connectors.refreshStatus(toolkit, checkAuthorization: true) }
                                .font(.footnote).foregroundStyle(InstantStyle.muted).frame(minHeight: 44)
                                .accessibilityIdentifier("connection.\(toolkit).refresh")
                            if status == .connected || status == .pending || connectors.awaitingToolkit == toolkit {
                                Button("Disconnect") { connectors.disconnect(toolkit) }
                                    .font(.footnote).foregroundStyle(InstantStyle.muted).frame(minHeight: 44)
                                    .accessibilityIdentifier("connection.\(toolkit).disconnect")
                            }
                        }.buttonStyle(.plain).disabled(connectors.isBusy)
                        Text("Authorize in the secure browser, then return here. Your account is connected only after the server verifies it. Impo uses \(name) only when you ask. Relevant content is sent to Impo and its AI service when you ask.")
                            .font(.caption).foregroundStyle(InstantStyle.muted).lineSpacing(2)
                    }
                    if let error = connectors.error, connectors.errorToolkit == toolkit {
                        Text(error).font(.caption).foregroundStyle(InstantStyle.muted)
                            .accessibilityIdentifier("connection.\(toolkit).error")
                    }
                }
                .padding(20).frame(maxWidth: .infinity, alignment: .leading)
                .paperSurface(cornerRadius: 18).padding(18)
            }.scrollIndicators(.hidden)
        }
        .foregroundStyle(InstantStyle.ink).presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        .sheet(item: $connectors.authorization, onDismiss: { connectors.refreshStatus(toolkit, checkAuthorization: true) }) { authorization in
            ConnectorAuthorizationSheet(url: authorization.url).ignoresSafeArea().swipeToDismiss()
        }
    }
}

private struct ConnectorAuthorizationSheet: UIViewControllerRepresentable {
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
