import SwiftUI
import InstantClient

/// Gadgets paired to this account, and Bluetooth setup for a new one.
struct GadgetsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var gadgets: [Gadget] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var setup: GadgetSetupModel?
    @State private var removing: Gadget?

    var body: some View {
        ZStack {
            InstantBackground()
            VStack(spacing: 14) {
                BackHeader(title: "Gadgets", onBack: { if setup == nil { dismiss() } else { endSetup() } })
                ScrollView {
                    Group {
                        if let setup { GadgetSetupView(setup: setup, onDone: endSetup) } else { list }
                    }.padding(.horizontal, 18).padding(.bottom, 35)
                }.scrollIndicators(.hidden)
            }.padding(.top, 16)
        }
        .foregroundStyle(InstantStyle.ink).tint(InstantStyle.forest).presentationDragIndicator(.visible)
        .task { await load() }
        .onDisappear { setup?.stop() }
        .confirmationDialog("Remove \(removing?.name ?? "gadget")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button("Remove", role: .destructive) { if let removing { remove(removing) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It disconnects from your account. Set it up again to keep using it.")
        }
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Talk to \(model.assistantName) away from your phone.").font(InstantStyle.serif(28))
            Text("A gadget sends what you type or say to your personal agent and shows the reply. It connects over its own Wi-Fi.")
                .font(.system(size: 15)).foregroundStyle(InstantStyle.muted).lineSpacing(4)
            if model.listeningClient() == nil {
                Text("Sign in to set up a gadget.").font(.caption).foregroundStyle(InstantStyle.muted)
            } else {
                if !gadgets.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(Array(gadgets.enumerated()), id: \.element.id) { index, gadget in
                            if index > 0 { Divider().overlay(InstantStyle.border.opacity(0.6)).padding(.leading, 14) }
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(gadget.name).font(.system(size: 16, weight: .medium))
                                    Text(gadget.online ? "Connected" : "Offline").font(.caption)
                                        .foregroundStyle(gadget.online ? InstantStyle.forest : InstantStyle.muted)
                                }
                                Spacer(minLength: 8)
                                Button("Remove") { removing = gadget }
                                    .font(.footnote).foregroundStyle(InstantStyle.muted).frame(minHeight: 44)
                                    .accessibilityIdentifier("gadget.remove.\(gadget.nodeId)")
                            }.padding(.horizontal, 14).frame(minHeight: 58)
                        }
                    }.paperSurface(cornerRadius: 16)
                } else if !loaded && error == nil {
                    HStack(spacing: 10) { ProgressView().controlSize(.small).tint(InstantStyle.forest); Text("Loading gadgets…").font(.footnote).foregroundStyle(InstantStyle.muted) }
                }
                if let error {
                    Text(error).font(.caption).foregroundStyle(InstantStyle.muted).accessibilityIdentifier("gadgets.error")
                }
                GadgetActionButton(title: "Set up a gadget", symbol: "plus") {
                    guard let client = model.listeningClient() else { return }
                    let next = GadgetSetupModel(client: client)
                    setup = next
                    next.start()
                }.accessibilityIdentifier("gadgets.add")
            }
        }
    }

    private func endSetup() {
        setup?.stop()
        setup = nil
        Task { await load() }
    }

    private func load() async {
        guard let client = model.listeningClient() else { return }
        do { gadgets = try await client.gadgets(); error = nil; loaded = true }
        catch { self.error = "Impo couldn't load your gadgets. Check your connection." }
    }

    private func remove(_ gadget: Gadget) {
        guard let client = model.listeningClient() else { return }
        Task {
            do { try await client.removeGadget(pairingId: gadget.pairingId); gadgets.removeAll { $0.id == gadget.id }; error = nil }
            catch { self.error = "Impo couldn't remove \(gadget.name). Try again." }
        }
    }
}

private struct GadgetSetupView: View {
    let setup: GadgetSetupModel
    let onDone: () -> Void
    @State private var ssid = ""
    @State private var password = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            switch setup.step {
            case .unavailable(let message):
                heading("Bluetooth is needed", message)
            case .searching:
                heading("Looking for your gadget", "Turn it on and keep it nearby. A gadget that has been used before must be reset first: hold its button for 5 seconds.")
                if setup.nearby.isEmpty {
                    progress("Searching…")
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(setup.nearby.enumerated()), id: \.element.id) { index, gadget in
                            if index > 0 { Divider().overlay(InstantStyle.border.opacity(0.6)).padding(.leading, 14) }
                            Button { setup.connect(gadget) } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(gadget.name).font(.system(size: 16, weight: .medium))
                                        if gadget.isSetUp { Text("Already set up · reset it to pair").font(.caption).foregroundStyle(InstantStyle.muted) }
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(InstantStyle.muted)
                                }.padding(.horizontal, 14).frame(minHeight: 58).contentShape(Rectangle())
                            }.buttonStyle(.plain).disabled(gadget.isSetUp).accessibilityIdentifier("gadget.nearby.\(gadget.name)")
                        }
                    }.paperSurface(cornerRadius: 16)
                }
            case .connecting:
                heading("Connecting to \(setup.gadgetName)", "Keep your iPhone close to the gadget.")
                progress("Opening a secure setup session…")
            case .confirm:
                heading("Press the button on your gadget", "A short press on \(setup.gadgetName) confirms that this is the gadget you're holding.")
                progress("Waiting for the press…")
            case .wifi:
                heading("Choose Wi-Fi for \(setup.gadgetName)", "The gadget uses this network on its own. The password goes straight to the gadget over the encrypted session.")
                if let error = setup.wifiError {
                    Text(error).font(.footnote).foregroundStyle(InstantStyle.accent).accessibilityIdentifier("gadget.wifi.error")
                }
                wifiForm
            case .joining(let status):
                heading("Setting up \(setup.gadgetName)", "This takes up to a minute.")
                progress(status)
            case .done:
                heading("\(setup.gadgetName) is ready", "It's connected to your account. Try saying something to it.")
                GadgetActionButton(title: "Done", symbol: "checkmark", action: onDone).accessibilityIdentifier("gadget.setup.done")
            case .failed(let message):
                heading("Setup didn't finish", message)
                GadgetActionButton(title: "Try again", symbol: "arrow.clockwise") { setup.start() }.accessibilityIdentifier("gadget.setup.retry")
            }
        }
    }

    @ViewBuilder private var wifiForm: some View {
        VStack(spacing: 0) {
            TextField("Network name", text: $ssid)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .padding(.horizontal, 14).frame(minHeight: 50).accessibilityIdentifier("gadget.wifi.ssid")
            Divider().overlay(InstantStyle.border.opacity(0.6)).padding(.leading, 14)
            SecureField("Password", text: $password)
                .padding(.horizontal, 14).frame(minHeight: 50).accessibilityIdentifier("gadget.wifi.password")
        }.paperSurface(cornerRadius: 16)
        GadgetActionButton(title: "Connect", symbol: "wifi") { setup.join(ssid: ssid, password: password) }
            .disabled(ssid.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)
            .accessibilityIdentifier("gadget.wifi.connect")
        HStack {
            Text("Networks the gadget can see").font(.footnote.weight(.semibold)).foregroundStyle(InstantStyle.muted)
            Spacer()
            if setup.isScanningWiFi { ProgressView().controlSize(.small).tint(InstantStyle.forest) }
            else { Button("Scan again") { setup.scanWiFi() }.font(.footnote).frame(minHeight: 44) }
        }.padding(.top, 4)
        if !setup.networks.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(setup.networks.enumerated()), id: \.element.id) { index, network in
                    if index > 0 { Divider().overlay(InstantStyle.border.opacity(0.6)).padding(.leading, 14) }
                    Button { ssid = network.ssid } label: {
                        HStack {
                            Text(network.ssid).font(.system(size: 16))
                            Spacer()
                            if ssid == network.ssid { Image(systemName: "checkmark").foregroundStyle(InstantStyle.forest) }
                            if network.secure { Image(systemName: "lock.fill").font(.caption).foregroundStyle(InstantStyle.muted) }
                        }.padding(.horizontal, 14).frame(minHeight: 48).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
            }.paperSurface(cornerRadius: 16)
        }
    }

    private func heading(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(InstantStyle.serif(28))
            Text(detail).font(.system(size: 15)).foregroundStyle(InstantStyle.muted).lineSpacing(4)
        }
    }

    private func progress(_ text: String) -> some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small).tint(InstantStyle.forest)
            Text(text).font(.footnote).foregroundStyle(InstantStyle.muted)
        }.accessibilityIdentifier("gadget.setup.progress")
    }
}

private struct GadgetActionButton: View {
    let title: String
    let symbol: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack {
                Text(title).font(.system(size: 15, weight: .medium))
                Spacer()
                Image(systemName: symbol)
            }.foregroundStyle(InstantStyle.forest).padding(.horizontal, 16).frame(minHeight: 48)
            .instantGlass(cornerRadius: 13, tint: InstantStyle.accent.opacity(0.18))
        }.buttonStyle(.plain)
    }
}
