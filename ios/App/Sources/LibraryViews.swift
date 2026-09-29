import SwiftUI
import Observation
import InstantClient

private let libraryInk = InstantStyle.ink
private let libraryMuted = InstantStyle.muted
private let libraryAction = InstantStyle.forest

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    var onBack: () -> Void
    @State private var sheet: SettingsSheet?
    @State private var modeExpanded = true
    @State private var developmentExpanded = false
    @State private var showReset = false

    var body: some View {
        @Bindable var model = model
        ZStack {
            InstantBackground()
            VStack(spacing: 12) {
                if sheet == nil {
                    BackHeader(title: "Settings", onBack: onBack)
                        .accessibilityIdentifier("settings.back")
                } else {
                    // Keep the covered header's space without exposing a second Back action.
                    Color.clear.frame(height: 60).accessibilityHidden(true)
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        sectionLabel("Plan (Demo)")
                        LibraryCard {
                            VStack(alignment: .leading, spacing: 24) {
                                membershipCard
                                HStack {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("Impo Preview (Demo)").font(InstantStyle.serif(21)).foregroundStyle(libraryInk)
                                        Text("A little space to try things out.").font(.footnote).foregroundStyle(libraryMuted)
                                    }
                                    Spacer(minLength: 8)
                                    Button("Manage") { sheet = .plan }
                                        .font(.subheadline.weight(.medium)).foregroundStyle(InstantStyle.paperElevated)
                                        .padding(.horizontal, 17).padding(.vertical, 11).background(InstantStyle.forest, in: Capsule())
                                        .accessibilityIdentifier("settings.manage")
                                }
                                Button { withAnimation(.easeInOut(duration: 0.2)) { modeExpanded.toggle() } } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text("Mode (Demo)").font(InstantStyle.serif(21))
                                            Text("Choose your preferred style.").font(.footnote).foregroundStyle(libraryMuted)
                                        }
                                        Spacer()
                                        Text(model.mode).foregroundStyle(libraryMuted)
                                        Image(systemName: modeExpanded ? "chevron.down" : "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(libraryMuted)
                                    }.contentShape(Rectangle())
                                }.buttonStyle(.plain)
                                if modeExpanded {
                                    VStack(spacing: 10) {
                                        modeChoice("Balanced", description: "A thoughtful pace for everyday things.")
                                        modeChoice("Power", description: "Space for more involved questions.")
                                    }
                                    Text("Preview preference · Model selection is not connected yet.")
                                        .font(.caption).foregroundStyle(libraryMuted)
                                }
                                settingsRow("Monthly Usage (Demo)", detail: "Available when plans launch") { sheet = .usage }
                                settingsRow("Billing (Demo)") { sheet = .plan }
                            }.padding(18)
                        }
                        sectionLabel("Capabilities & Connections")
                        LibraryCard {
                            VStack(spacing: 0) {
                                settingsRow("Connectors", detail: "Calendar, Health & more") { sheet = .connections }
                                    .accessibilityIdentifier("settings.connections")
                                Rectangle().fill(InstantStyle.border).frame(height: 0.5)
                                settingsRow("Echo Debug", detail: "View and export device logs") { sheet = .debug }
                                    .accessibilityIdentifier("settings.listening-debug")
                                Rectangle().fill(InstantStyle.border).frame(height: 0.5)
                                settingsRow("Your profile") { sheet = .profile }
                                    .accessibilityIdentifier("settings.profile")
                            }.padding(.horizontal, 18)
                        }
                        DisclosureGroup(isExpanded: $developmentExpanded) {
                            VStack(alignment: .leading, spacing: 15) {
                                Toggle("Use local API server", isOn: $model.useLiveBackend)
                                    .accessibilityIdentifier("settings.backend")
                                    .onChange(of: model.useLiveBackend) { _, _ in model.persistProfile() }
                                TextField("http://127.0.0.1:3001", text: $model.backendURL)
                                    .textContentType(.URL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .font(.footnote).padding(12).paperSurface(cornerRadius: 12)
                                    .accessibilityIdentifier("settings.backendURL")
                                    .onSubmit { model.persistProfile() }
                                    .onChange(of: model.backendURL) { _, _ in model.persistProfile() }
                                Text("Chat connects to your Impo API server. API keys stay on that server.")
                                    .font(.caption).foregroundStyle(libraryMuted)
                                Button("Restart welcome experience") { showReset = true }
                                    .font(.subheadline).foregroundStyle(libraryAction)
                                    .accessibilityIdentifier("settings.restart")
                            }.padding(.top, 16)
                        } label: { Text("Development").font(InstantStyle.serif(19)) }
                            .tint(libraryAction).padding(18)
                            .paperSurface(cornerRadius: 16)
                        Text("Impo · Development preview").font(.caption).foregroundStyle(libraryMuted)
                            .frame(maxWidth: .infinity).padding(.bottom, 20)
                    }.padding(.horizontal, 16).padding(.top, 10)
                }.scrollIndicators(.hidden)
            }
            .accessibilityHidden(sheet != nil)
        }
        .foregroundStyle(libraryInk).tint(libraryAction)
        .sheet(item: $sheet) { route in
            Group {
                switch route {
                case .debug: ListeningDebugView()
                case .connections: LibraryConnectionsView()
                case .profile: ProfileDetailView()
                case .plan: LibraryInfoSheet(title: "Your Impo preview", symbol: "sparkles", text: "Explore your assistant, conversations, and personal space. Plans and billing are not available in this preview.")
                case .usage: LibraryInfoSheet(title: "Monthly usage", symbol: "chart.bar.xaxis", text: "Usage information will appear here when plans are available. There is no subscription or allowance attached to this preview.")
                }
            }.swipeToDismiss()
        }
        .confirmationDialog("Restart the welcome experience?", isPresented: $showReset, titleVisibility: .visible) {
            Button("Restart") { ["instant.demo.notes", "instant.demo.tasks"].forEach(UserDefaults.standard.removeObject(forKey:)); model.resetDemo(); onBack() }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var membershipCard: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(spacing: 8) {
                Image("InstantMark").resizable().scaledToFit().frame(width: 20, height: 28).accessibilityHidden(true)
                Text("Impo").font(InstantStyle.serif(26))
                Spacer()
                Text("Preview").font(.caption).padding(.horizontal, 9).padding(.vertical, 4)
                    .overlay(Capsule().stroke(InstantStyle.forest.opacity(0.25), lineWidth: 0.7))
            }
            HStack(alignment: .bottom, spacing: 8) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.displayName.isEmpty ? "Welcome" : model.displayName).font(InstantStyle.serif(24))
                    Text("Your personal space").font(.footnote).foregroundStyle(libraryMuted)
                }.frame(maxWidth: .infinity, alignment: .leading)
                Image("JournalRobin").resizable().scaledToFit().frame(width: 96, height: 94).accessibilityHidden(true)
            }
        }.padding(20).frame(maxWidth: .infinity, minHeight: 196, alignment: .leading)
            .background(LinearGradient(colors: [InstantStyle.accent.opacity(0.38), InstantStyle.accent.opacity(0.22)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(InstantStyle.accent.opacity(0.65), lineWidth: 0.8))
            .accessibilityElement(children: .combine)
    }

    private func modeChoice(_ name: String, description: String) -> some View {
        Button {
            model.mode = name
            model.persistProfile()
        } label: {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(name).font(InstantStyle.serif(19))
                    Text(description).font(.footnote).foregroundStyle(libraryMuted)
                }
                Spacer(minLength: 8)
                Image(systemName: model.mode == name ? "record.circle.fill" : "circle")
                    .font(.title3).foregroundStyle(model.mode == name ? InstantStyle.forest : libraryMuted.opacity(0.6))
            }.padding(15).frame(maxWidth: .infinity, alignment: .leading)
                .background(model.mode == name ? InstantStyle.sage.opacity(0.3) : InstantStyle.paper, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(model.mode == name ? InstantStyle.forest.opacity(0.4) : InstantStyle.border, lineWidth: 0.7))
        }.buttonStyle(.plain).accessibilityIdentifier("settings.mode.\(name.lowercased())")
            .accessibilityAddTraits(model.mode == name ? .isSelected : [])
    }

    private func settingsRow(_ title: String, detail: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(InstantStyle.serif(19))
                    if let detail { Text(detail).font(.caption).foregroundStyle(libraryMuted) }
                }
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 16, weight: .medium)).foregroundStyle(libraryMuted.opacity(0.65))
            }.frame(minHeight: 44).padding(.vertical, 8).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }

    private func sectionLabel(_ title: String) -> some View {
        HStack(spacing: 12) {
            Text(title).font(InstantStyle.serif(18)).foregroundStyle(libraryInk)
            Rectangle().fill(InstantStyle.border).frame(height: 0.5)
        }.padding(.horizontal, 4)
    }

    private enum SettingsSheet: String, Identifiable {
        case connections, profile, plan, usage, debug
        var id: String { rawValue }
    }
}

struct MemoriesView: View {
    @Environment(ListeningModel.self) private var listening
    @Environment(AppModel.self) private var model
    @Environment(MemoriesModel.self) private var memories
    @State private var showingTimeline = true
    @State private var detail: MemoryDetail?

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 17) {
                HStack {
                    Text("Memories").font(InstantStyle.serif(36))
                    Spacer()
                    NotificationPermissionButton()
                }.padding(.bottom, 4)
                Picker("Memories view", selection: $showingTimeline) {
                    Text("Echo").tag(true)
                    Text("Notes").tag(false)
                }.pickerStyle(.segmented).accessibilityIdentifier("memories.sections")
            }.padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 12)
            if showingTimeline {
                ListeningTranscriptLibrary()
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 17) {
                        Button { detail = .profile } label: { profileCard }.buttonStyle(.plain).accessibilityIdentifier("memories.profile")
                        if let error = memories.error { Text(error).font(.footnote).foregroundStyle(InstantStyle.accent) }
                        Text("All Memories").font(InstantStyle.serif(22)).padding(.horizontal, 8).padding(.top, 7)
                        Button { detail = .category(.health) } label: { healthCard }.buttonStyle(.plain).accessibilityIdentifier("memories.category.health")
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 9), GridItem(.flexible(), spacing: 9)], spacing: 9) {
                            ForEach(MemoryCategoryInfo.folders) { folder($0) }
                        }
                        Button { model.selectedTab = 0 } label: {
                            HStack(spacing: 11) {
                                Image(systemName: "plus").font(.title3)
                                Text("Tell \(model.assistantName) more about you…").font(.system(size: 15)).lineLimit(1).minimumScaleFactor(0.85)
                                Spacer(minLength: 0)
                                Image(systemName: "bubble.left").font(.system(size: 18))
                            }.foregroundStyle(libraryInk).padding(16)
                                .instantGlass(cornerRadius: 28)
                        }.buttonStyle(.plain).accessibilityIdentifier("memories.compose")
                        Text(memories.isLive ? "\(model.assistantName) updates these every hour from your conversations and Echo." : "Memories appear here once \(model.assistantName) is connected.")
                            .font(.caption).foregroundStyle(libraryMuted).frame(maxWidth: .infinity).multilineTextAlignment(.center)
                    }.padding(.horizontal, 16).padding(.bottom, 24)
                }.scrollIndicators(.hidden)
                    .refreshable { await memories.refresh() }
                    .task { await memories.refresh() }
            }
        }.foregroundStyle(libraryInk)
            .fullScreenCover(item: $detail) { destination in
                Group {
                    switch destination {
                    case .profile: ProfileDetailView()
                    case .category(let info): MemoryCategoryView(info: info)
                    }
                }.swipeToDismiss()
            }
            .onChange(of: model.transcriptNavigationID) { _, _ in showingTimeline = true }
    }

    /// The newest facts about the user and their preferences.
    private var highlights: [Memory] {
        let personal = memories.pages[MemoryCategoryInfo.personal.id] ?? [], preferences = memories.pages[MemoryCategoryInfo.preferences.id] ?? []
        var seen = Set<String>()
        return (personal.prefix(2) + preferences.prefix(2)).filter { seen.insert($0.id).inserted }
    }

    private var profileCard: some View {
        LibraryCard {
            VStack(alignment: .leading, spacing: 12) {
                Image(systemName: "crown.fill").foregroundStyle(InstantStyle.accent)
                Text("What I know about \(model.nameOrYou)").font(InstantStyle.serif(23))
                VStack(alignment: .leading, spacing: 7) {
                    if highlights.isEmpty {
                        if !model.displayName.isEmpty { Text("•  Name: \(model.displayName)") }
                        Text("•  Nothing yet. Chat with \(model.assistantName) and it will start to learn.")
                    } else {
                        ForEach(highlights) { Text("•  \($0.content)").lineLimit(2) }
                    }
                }.font(.system(size: 14)).foregroundStyle(libraryMuted).lineSpacing(3)
                Text("View more").font(.system(size: 16)).foregroundStyle(libraryAction).padding(.top, 2)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
        }
    }

    private var healthCard: some View {
        let health = memories.pages[MemoryCategoryInfo.health.id] ?? []
        return LibraryCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Image(systemName: "heart.fill").font(.system(size: 13)).foregroundStyle(InstantStyle.forest)
                        .frame(width: 30, height: 30).background(InstantStyle.sage.opacity(0.4), in: RoundedRectangle(cornerRadius: 9))
                    Spacer()
                    Text(itemCount(memories.count("health"))).font(.caption).foregroundStyle(libraryMuted)
                }
                Text("Health").font(InstantStyle.serif(23))
                if health.isEmpty {
                    Text("Allergies, diet, exercise and sleep you mention will be kept here.").font(.system(size: 14)).foregroundStyle(libraryMuted)
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(health.prefix(3)) { Text("•  \($0.content)").lineLimit(2) }
                    }.font(.system(size: 14)).foregroundStyle(libraryMuted)
                }
            }.padding(18)
        }
    }

    private func folder(_ info: MemoryCategoryInfo) -> some View {
        let count = memories.count(info.id)
        return Button { detail = .category(info) } label: {
            LibraryCard {
                VStack(alignment: .leading, spacing: 10) {
                    Image(systemName: info.symbol).font(.system(size: 26, weight: .light))
                        .symbolRenderingMode(.palette).foregroundStyle(InstantStyle.forest, InstantStyle.accent.opacity(0.55))
                        .frame(height: 34)
                    Text(info.id == MemoryCategoryInfo.personal.id ? "About \(model.nameOrYou)" : info.title)
                        .font(InstantStyle.serif(19)).lineLimit(2).frame(minHeight: 44, alignment: .bottomLeading)
                    Text(itemCount(count)).font(.system(size: 13)).foregroundStyle(libraryMuted)
                }.frame(maxWidth: .infinity, minHeight: 114, alignment: .leading).padding(18)
            }.opacity(count == 0 ? 0.6 : 1)
        }.buttonStyle(.plain).accessibilityIdentifier("memories.category.\(info.id)")
    }
}

private func itemCount(_ count: Int) -> String { "\(count) \(count == 1 ? "Item" : "Items")" }

struct AssistantView: View {
    @Environment(AppModel.self) private var model
    @State private var editing = false
    @State private var name = ""
    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                HStack { Text(model.assistantName).font(InstantStyle.serif(36)); Spacer(); NotificationPermissionButton() }
                AssistantAvatar(index: model.avatarIndex, size: 158)
                    .padding(18)
                    .background(InstantStyle.sage.opacity(0.2), in: RoundedRectangle(cornerRadius: 40))
                    .overlay(RoundedRectangle(cornerRadius: 40).stroke(InstantStyle.border, lineWidth: 0.8))
                    .padding(.top, 17)
                VStack(spacing: 9) {
                    Text("Your everyday companion.").font(InstantStyle.serif(26))
                    Text("A familiar face. A little more you.").font(.system(size: 16)).foregroundStyle(libraryMuted)
                }
                HStack(spacing: 6) {
                    ForEach(AssistantLook.choices, id: \.rawValue) { look in
                        let index = look.rawValue
                        Button { model.avatarIndex = index; model.persistProfile() } label: {
                            AssistantAvatar(index: index, size: 42)
                                .padding(4)
                                .background(model.avatarIndex == index ? InstantStyle.sage.opacity(0.28) : .clear, in: RoundedRectangle(cornerRadius: 17))
                                .overlay(RoundedRectangle(cornerRadius: 17).stroke(model.avatarIndex == index ? InstantStyle.forest : .clear, lineWidth: 1.3))
                        }.buttonStyle(.plain).accessibilityLabel("\(look.name) avatar")
                            .accessibilityIdentifier("assistant.avatar.\(index)")
                            .accessibilityAddTraits(model.avatarIndex == index ? .isSelected : [])
                    }
                }.padding(.vertical, 5)
                LibraryCard {
                    VStack(alignment: .leading, spacing: 22) {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) { Text("Name").font(.caption).foregroundStyle(libraryMuted); Text(model.assistantName).font(InstantStyle.serif(23)) }
                            Spacer()
                            Button("Edit") { name = model.assistantName; editing = true }.foregroundStyle(libraryAction)
                                .accessibilityIdentifier("assistant.editName")
                        }
                        Rectangle().fill(InstantStyle.border).frame(height: 0.5)
                        Text("Thoughtful, curious, and here to help.").font(InstantStyle.serif(22))
                        Text("This is a place for your assistant’s character to take shape. Your name and appearance choices are saved on this device.")
                            .font(.system(size: 15)).foregroundStyle(libraryMuted).lineSpacing(4)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(23)
                }
            }.padding(20).padding(.bottom, 25)
        }.scrollIndicators(.hidden).foregroundStyle(libraryInk)
            .alert("What should I call your assistant?", isPresented: $editing) {
                TextField("Name", text: $name).accessibilityIdentifier("assistant.name")
                Button("Save") {
                    let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !clean.isEmpty { model.assistantName = String(clean.prefix(30)); model.persistProfile() }
                }
                Button("Cancel", role: .cancel) {}
            }
    }
}

private struct ProfileDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(MemoriesModel.self) private var memories
    @Environment(\.dismiss) private var dismiss
    @State private var editing = false
    @State private var name = ""
    var body: some View {
        LibrarySheet(title: "", onBack: { dismiss() }) {
            VStack(alignment: .leading, spacing: 17) {
                LibraryCard {
                    VStack(alignment: .leading, spacing: 17) {
                        Image(systemName: "crown.fill").font(.system(size: 22)).foregroundStyle(InstantStyle.forest)
                            .frame(width: 48, height: 48)
                            .background(InstantStyle.accent.opacity(0.23), in: RoundedRectangle(cornerRadius: 13))
                            .overlay(RoundedRectangle(cornerRadius: 13).stroke(InstantStyle.border, lineWidth: 0.7))
                        Text("What I know about \(model.nameOrYou)").font(InstantStyle.serif(27))
                        Text("•  Name: \(model.displayName.isEmpty ? "Not set" : model.displayName)")
                        Text("•  Time zone: \(TimeZone.current.identifier)")
                        Button(model.displayName.isEmpty ? "Add your name" : "Edit your name") { name = model.displayName; editing = true }
                            .font(.subheadline).foregroundStyle(libraryAction).accessibilityIdentifier("profile.edit")
                    }.font(.system(size: 17)).lineSpacing(5).frame(maxWidth: .infinity, alignment: .leading).padding(23)
                }
                MemoryList(info: .personal, title: "About \(model.nameOrYou)")
                MemoryList(info: .preferences, title: "Preferences")
            }
        }.task {
            await memories.load(MemoryCategoryInfo.personal.id)
            await memories.load(MemoryCategoryInfo.preferences.id)
        }.alert("Your name", isPresented: $editing) {
            TextField("Name", text: $name).accessibilityIdentifier("profile.name")
            Button("Save") {
                let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
                if !clean.isEmpty { model.displayName = String(clean.prefix(40)); model.persistProfile() }
            }
            Button("Cancel", role: .cancel) {}
        }
    }
}

private enum MemoryDetail: Identifiable, Hashable {
    case profile
    case category(MemoryCategoryInfo)
    var id: String { switch self { case .profile: "profile"; case .category(let info): info.id } }
}

private struct MemoryCategoryView: View {
    @Environment(AppModel.self) private var model
    @Environment(MemoriesModel.self) private var memories
    @Environment(\.dismiss) private var dismiss
    let info: MemoryCategoryInfo
    var body: some View {
        LibrarySheet(title: info.id == MemoryCategoryInfo.personal.id ? "About \(model.nameOrYou)" : info.title, onBack: { dismiss() }) {
            VStack(alignment: .leading, spacing: 18) {
                MemoryList(info: info, title: nil)
                if info == .health { DeviceAccessCard(kind: "health").padding(.top, 8) }
            }
        }.task { await memories.load(info.id) }
            .refreshable { await memories.load(info.id) }
    }
}

/// One category's memories, newest first, with paging and forgetting.
private struct MemoryList: View {
    @Environment(AppModel.self) private var model
    @Environment(MemoriesModel.self) private var memories
    let info: MemoryCategoryInfo
    let title: String?
    @State private var forgetting: Memory?
    private var items: [Memory] { memories.pages[info.id] ?? [] }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title { Text(title).font(InstantStyle.serif(22)).padding(.top, 5) }
            if items.isEmpty && !memories.loading.contains(info.id) {
                Text(memories.isLive ? "Nothing here yet. \(model.assistantName) adds memories after your conversations and Echo recordings."
                     : "Memories appear here once \(model.assistantName) is connected.")
                    .foregroundStyle(libraryMuted).padding(.vertical, 12).accessibilityIdentifier("memories.empty")
            }
            ForEach(items) { memory in
                LibraryCard {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(memory.content).font(.system(size: 17)).lineSpacing(4)
                        let others = memory.categories.filter { $0 != info.id }.map { MemoryCategoryInfo.named($0).title }
                        if !others.isEmpty { Text(others.joined(separator: " · ")).font(.caption).foregroundStyle(InstantStyle.forest) }
                        HStack {
                            Text(caption(memory)).font(.caption).foregroundStyle(libraryMuted)
                            Spacer()
                            Button(role: .destructive) { forgetting = memory } label: { Image(systemName: "trash").font(.footnote) }
                                .accessibilityLabel("Forget this memory").accessibilityIdentifier("memory.forget")
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
                }.accessibilityIdentifier("memory.row")
            }
            if memories.hasMore(info.id) {
                Button("Show more") { Task { await memories.load(info.id, more: true) } }.foregroundStyle(libraryAction)
            }
        }.confirmationDialog("Forget this memory?", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }), titleVisibility: .visible) {
            Button("Forget", role: .destructive) { if let memory = forgetting { Task { await memories.forget(memory) } } }
        } message: { Text("\(model.assistantName) will no longer remember this.") }
    }
    private func caption(_ memory: Memory) -> String {
        var parts: [String] = []
        if let date = memoryDate(memory.updatedAt) { parts.append("Updated \(date.formatted(date: .abbreviated, time: .omitted))") }
        if let expires = memory.expiresAt.flatMap(memoryDate) { parts.append("Until \(expires.formatted(date: .abbreviated, time: .omitted))") }
        let echo = memory.sourceIds.contains { $0.hasPrefix("echo:") }, chat = memory.sourceIds.contains { $0.hasPrefix("chat:") }
        if echo || chat { parts.append(echo && chat ? "From chat and Echo" : echo ? "From Echo" : "From chat") }
        return parts.joined(separator: " · ")
    }
}

private func memoryDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}

private struct LibraryConnectionsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        LibrarySheet(title: "Connections", onBack: { dismiss() }) {
            VStack(alignment: .leading, spacing: 18) {
                Text("Make a little more possible.").font(InstantStyle.serif(28))
                Text("Choose what your assistant can read on this iPhone and from connected accounts. When you ask, the relevant results are sent to Impo and its AI service to answer you.")
                    .font(.system(size: 15)).foregroundStyle(libraryMuted).lineSpacing(4)
                DeviceAccessCard(kind: "calendar")
                DeviceAccessCard(kind: "health")
                GmailAccessCard()
                Label("Messages", systemImage: "message.fill").font(InstantStyle.serif(21)).padding(.top, 8)
                Text("iOS does not give Impo access to your existing SMS or iMessage history. You can paste a message into the conversation for help.")
                    .font(.footnote).foregroundStyle(libraryMuted).accessibilityIdentifier("connection.messages.unavailable")
                Text("Reminders, Contacts and more accounts will be added later.").font(.footnote).foregroundStyle(libraryMuted)
                if model.useLiveBackend {
                    Text(model.deviceConnectionStatus).font(.caption).foregroundStyle(libraryMuted)
                } else {
                    Text("Live chat is needed to ask about your device data. Enable your local server in Settings → Development.")
                        .font(.caption).foregroundStyle(libraryMuted)
                }
            }
        }.onAppear {
            model.deviceData.refreshAuthorizationStatus()
            model.refreshGmailConnection()
        }
    }
}

private struct LibraryInfoSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let symbol: String
    let text: String
    var body: some View {
        LibrarySheet(title: "", onBack: { dismiss() }) {
            VStack(alignment: .leading, spacing: 22) {
                Image(systemName: symbol).font(.system(size: 36, weight: .light)).foregroundStyle(libraryAction)
                    .frame(width: 80, height: 80).instantGlass(cornerRadius: 24, tint: InstantStyle.accent.opacity(0.2))
                Text(title).font(InstantStyle.serif(32))
                Text(text).font(.system(size: 18)).foregroundStyle(libraryMuted).lineSpacing(6)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 45)
        }
    }
}

private struct LibrarySheet<Content: View>: View {
    let title: String
    let onBack: () -> Void
    @ViewBuilder var content: Content
    var body: some View {
        ZStack {
            InstantBackground()
            VStack(spacing: 14) {
                BackHeader(title: title, onBack: onBack)
                ScrollView { content.padding(.horizontal, 18).padding(.bottom, 35) }.scrollIndicators(.hidden)
            }.padding(.top, 16)
        }.foregroundStyle(libraryInk).tint(libraryAction).presentationDragIndicator(.visible)
    }
}

// Page content keeps its own inset; paper surfaces remain distinct from glass tools.
private struct LibraryCard<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        content.frame(maxWidth: .infinity, alignment: .leading)
            .paperSurface(cornerRadius: 16)
    }
}
