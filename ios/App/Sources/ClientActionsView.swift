import SwiftUI
import InstantClient

/// Only an explicit foreground tap can hand an action to another app.
struct ClientActionsView: View {
    let actions: [ClientAction]
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @State private var opening: String?
    @State private var notice: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(actions) { action in
                Button { open(action) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: action.capability == "impo_navigate" ? "location" : action.isVideo ? "play.rectangle" : "link")
                            .font(.system(size: 22)).foregroundStyle(InstantStyle.accent)
                            .frame(width: 40, height: 40).background(InstantStyle.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(action.title).font(.system(size: 16, weight: .medium)).foregroundStyle(InstantStyle.ink)
                            Text(action.detail).font(.system(size: 13)).foregroundStyle(InstantStyle.muted).lineLimit(2)
                        }.multilineTextAlignment(.leading)
                        Spacer(minLength: 8)
                        Image(systemName: "arrow.up.right").foregroundStyle(InstantStyle.muted)
                    }
                    .padding(12).frame(minHeight: 60).frame(maxWidth: 360, alignment: .leading)
                    .paperSurface(cornerRadius: 14).contentShape(RoundedRectangle(cornerRadius: 14))
                }.buttonStyle(.plain).disabled(opening != nil || scenePhase != .active)
                    .accessibilityLabel("\(action.title), \(action.detail)")
                    .accessibilityHint("Opens another app or your browser")
                    .accessibilityIdentifier("message.action.\(action.capability)")
            }
            if let notice { Text(notice).font(.system(size: 14)).foregroundStyle(InstantStyle.muted) }
        }
    }

    private func open(_ action: ClientAction) {
        guard scenePhase == .active, opening == nil, let url = action.targetURL else { return }
        opening = action.id; notice = nil
        // The system respects installed apps and the user's Universal Link choices.
        openURL(url) { success in
            opening = nil
            notice = success ? nil : "Couldn't open this action. Try again."
        }
    }
}

#if DEBUG
/// Native action acceptance uses an injected URL handler, never an external app.
struct ClientActionsFixture: View {
    @State private var opens = 0
    @State private var generation = 0
    @State private var destination = ""
    private var actions: [ClientAction] {
        [("impo_open_link", "2b30cd6c-2d20-4f3c-8e98-464974947025", ["url": JSONValue.string("https://youtu.be/example")]),
         ("impo_navigate", "4bb9138b-cbc6-4071-9d36-9ad7b675b03c", ["destination": JSONValue.string("Union Square, San Francisco"), "mode": JSONValue.string("walking")])]
            .compactMap { name, id, parameters in
                ClientAction(toolName: name, output: .object(["kind": .string("client_action"), "schemaVersion": .number(1),
                    "actionId": .string(id), "capability": .string(name), "execution": .string("device"),
                    "interaction": .string("tap"), "status": .string("ready"), "parameters": .object(parameters)]))
            }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Your next step").font(InstantStyle.serif(26))
            Text("Open the video or get walking directions when you are ready.")
            ClientActionsView(actions: actions).id(generation)
                .environment(\.openURL, OpenURLAction { url in opens += 1; destination = url.host ?? ""; return .handled })
            Text("Opened: \(opens)").accessibilityIdentifier("actions.fixture.count")
            Text(destination).accessibilityIdentifier("actions.fixture.destination")
            Button("Restore cards") { generation += 1 }.accessibilityIdentifier("actions.fixture.restore")
            Spacer()
        }.padding(24).background(InstantStyle.paper)
    }
}
#endif
