import SwiftUI
import InstantClient
import UIKit

enum TodayPresentation {
    static func timestamp(_ value: String, timeZone: String, includeTime: Bool = false) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = parser.date(from: value)
        if date == nil { parser.formatOptions = [.withInternetDateTime]; date = parser.date(from: value) }
        guard let date else { return value }
        let formatter = DateFormatter(); formatter.timeZone = TimeZone(identifier: timeZone)
        formatter.dateStyle = .medium; formatter.timeStyle = includeTime ? .short : .none
        return formatter.string(from: date)
    }
    static func date(_ value: String) -> Date? {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: value)
    }
    static func dateLabel(_ brief: TodayBrief) -> String {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: brief.timeZone)
        if brief.localDate == formatter.string(from: Date()) { return "Today" }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = formatter.timeZone
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: Date()), brief.localDate == formatter.string(from: yesterday) { return "Yesterday" }
        return brief.localDate
    }
    static func symbol(_ kind: String) -> String {
        switch kind { case "early": "sunrise"; case "morning": "sun.max"; case "midday": "sun.horizon"; case "evening": "moon.stars"; default: "sparkles" }
    }
    static func tint(_ style: String) -> Color {
        switch style { case "plan": InstantStyle.sage; case "reflection": Color(red: 0.80, green: 0.78, blue: 0.88); case "discovery": Color(red: 0.70, green: 0.83, blue: 0.88); default: InstantStyle.accent }
    }
}

struct TodayView: View {
    @Environment(TodayModel.self) private var today
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @State private var showSettings = false
    @State private var capture: TodayCaptureRoute?
    @State private var source: TodaySourceRoute?
    @State private var deleting: TodayBrief?
    @State private var positions: [String: CGFloat] = [:]
    @State private var screenshotOffer = false
    @State private var actionError: String?

    private var visibleDate: String? {
        let candidates = today.briefs.filter { $0.content != nil && positions[$0.id] != nil }
        let preceding = candidates.filter { positions[$0.id]! <= 80 }.max { positions[$0.id]! < positions[$1.id]! }
        let following = candidates.filter { positions[$0.id]! > 80 }.min { positions[$0.id]! < positions[$1.id]! }
        return (preceding ?? following ?? today.briefs.first { $0.content != nil })?.localDate
    }
    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 30) {
                HStack {
                    Text("Today").font(InstantStyle.serif(36))
                    Spacer()
                    Button { if let date = visibleDate { capture = TodayCaptureRoute(date: date) } } label: {
                        Image(systemName: "square.on.square").frame(width: 44, height: 44)
                    }.accessibilityLabel("Capture full page").accessibilityIdentifier("today.capture").disabled(visibleDate == nil)
                    Button { showSettings = true } label: { Image(systemName: "slider.horizontal.3").frame(width: 44, height: 44) }
                        .accessibilityLabel("Brief preferences").accessibilityIdentifier("today.settings")
                    NotificationPermissionButton()
                }
                if let error = today.error {
                    Text(error).font(.callout).foregroundStyle(InstantStyle.muted).accessibilityIdentifier("today.error")
                }
                if today.briefs.isEmpty {
                    emptyState
                } else {
                    ForEach(today.briefs) { brief in
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(TodayPresentation.dateLabel(brief)).font(.caption).foregroundStyle(InstantStyle.muted)
                                    Label(brief.label, systemImage: TodayPresentation.symbol(brief.kind)).font(.system(size: 17, weight: .medium))
                                }
                                Spacer()
                                Menu {
                                    Button("Capture this day", systemImage: "square.on.square") { capture = TodayCaptureRoute(date: brief.localDate) }.disabled(brief.content == nil)
                                    Button("Delete brief", systemImage: "trash", role: .destructive) { deleting = brief }
                                } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
                                .accessibilityLabel("Brief options")
                            }
                            TodayBriefBody(brief: brief, exporting: false) { selected in source = TodaySourceRoute(brief: brief, source: selected) }
                        }
                        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named("todayFeed")).minY } action: { positions[brief.id] = $0 }
                        .accessibilityIdentifier("today.brief.\(brief.id)")
                        .id(brief.id)
                    }
                    if today.hasMore {
                        Button { Task { await today.refresh(more: true) } } label: {
                            HStack { Spacer(); if today.isLoading { ProgressView() }; Text("Earlier briefs"); Spacer() }.padding(.vertical, 16)
                        }.disabled(today.isLoading).accessibilityIdentifier("today.load-more")
                    }
                }
            }.padding(22).padding(.bottom, 28)
        }
        .coordinateSpace(name: "todayFeed").scrollIndicators(.hidden).foregroundStyle(InstantStyle.ink)
        .task(id: app.notificationBriefID) {
            guard let id = app.notificationBriefID else { return }
            await today.loadNotificationBrief(id)
            guard app.notificationBriefID == id else { return }
            proxy.scrollTo(id, anchor: .top); app.notificationBriefID = nil
        }
        .refreshable { await today.refresh() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--today-preview") {
                today.briefs = TodayPreview.briefs
                if ProcessInfo.processInfo.arguments.contains("--today-screenshot-notification") {
                    try? await Task.sleep(for: .seconds(2))
                    NotificationCenter.default.post(name: UIApplication.userDidTakeScreenshotNotification, object: nil)
                }
                return
            }
            #endif
            await today.refresh()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                if !Task.isCancelled { await today.refresh(preserveHistory: true) }
            }
        }
        .overlay(alignment: .bottom) {
            if screenshotOffer, let date = visibleDate {
                Button { screenshotOffer = false; capture = TodayCaptureRoute(date: date) } label: {
                    Label("Capture full page?", systemImage: "square.on.square")
                        .font(.system(size: 16, weight: .semibold)).padding(.horizontal, 22).padding(.vertical, 16)
                        .background(InstantStyle.forest, in: Capsule()).foregroundStyle(InstantStyle.paper)
                }.padding(.bottom, 18).accessibilityIdentifier("today.capture-offer")
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.userDidTakeScreenshotNotification)) { _ in
            guard !showSettings, capture == nil, source == nil, visibleDate != nil else { return }
            screenshotOffer = true
        }
        .task(id: screenshotOffer) {
            guard screenshotOffer else { return }
            try? await Task.sleep(for: .seconds(9))
            if !Task.isCancelled { screenshotOffer = false }
        }
        .sheet(isPresented: $showSettings) { TodaySettingsView().swipeToDismiss() }
        .onChange(of: app.listeningScope) { _, _ in capture = nil; source = nil; showSettings = false; positions = [:] }
        .sheet(item: $source) { TodaySourceView(route: $0).swipeToDismiss() }
        .fullScreenCover(item: $capture) { TodayCaptureView(initialDate: $0.date).swipeToDismiss() }
        .confirmationDialog("Delete this brief?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            if let brief = deleting {
                Button("Delete brief", role: .destructive) { Task { do { try await today.delete(brief) } catch { actionError = error.localizedDescription }; deleting = nil } }
            }
        } message: { Text("This removes the brief from your timeline. Your original conversations and transcripts stay saved.") }
        .alert("Couldn't complete that", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) { Button("OK") { actionError = nil } } message: { Text(actionError ?? "") }
    }
        }
    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack { Image(systemName: "sun.horizon").font(.system(size: 36, weight: .light)); Spacer(); Image("JournalRobin").resizable().scaledToFit().frame(width: 100, height: 95) }
            Text(today.isLoading ? "Gathering your briefs…" : "A little perspective, throughout your day.").font(InstantStyle.serif(28))
            Text(today.isLive ? "Morning, midday, and evening briefs will arrive here. Each one stays, so you can scroll back whenever you like." : "Sign in to see personal briefs made from your conversations and listening.")
                .font(.system(size: 16)).foregroundStyle(InstantStyle.muted).lineSpacing(4)
            if let settings = today.settings {
                Text(settings.slots.filter(\.enabled).map { "\($0.label) · \(String(format: "%02d:00", $0.hour))" }.joined(separator: "\n"))
                    .font(.caption).foregroundStyle(InstantStyle.forest).lineSpacing(5)
                Text("Your local time · Briefs start on the next hourly check.").font(.caption).foregroundStyle(InstantStyle.muted)
            }
        }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            .background(InstantStyle.accent.opacity(0.20), in: RoundedRectangle(cornerRadius: 20))
            .accessibilityIdentifier("today.empty")
    }
}

struct TodayBriefBody: View {
    let brief: TodayBrief
    var exporting = false
    var onSource: ((TodaySource) -> Void)?
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let content = brief.content, brief.status == "completed" {
                VStack(alignment: .leading, spacing: 13) {
                    Label("\(brief.localDate) · \(brief.label)", systemImage: TodayPresentation.symbol(brief.kind))
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(InstantStyle.forest)
                    Text(content.title).font(InstantStyle.serif(27)).fixedSize(horizontal: false, vertical: true)
                    Text(content.summary).font(.system(size: 16)).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(22)
                    .background(InstantStyle.accent.opacity(0.19), in: RoundedRectangle(cornerRadius: 20))
                ForEach(Array(content.cards.enumerated()), id: \.offset) { _, card in
                    VStack(alignment: .leading, spacing: 13) {
                        HStack(spacing: 7) {
                            Circle().fill(InstantStyle.forest).frame(width: 6, height: 6)
                            Text(card.eyebrow).font(.system(size: 12, weight: .semibold)).foregroundStyle(InstantStyle.forest)
                        }
                        Text(card.title).font(InstantStyle.serif(22)).fixedSize(horizontal: false, vertical: true)
                        Text(card.body).font(.system(size: 16)).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
                        if !card.bullets.isEmpty {
                            VStack(alignment: .leading, spacing: 10) {
                                ForEach(Array(card.bullets.enumerated()), id: \.offset) { _, bullet in
                                    HStack(alignment: .top, spacing: 9) { Text("•"); Text(bullet).fixedSize(horizontal: false, vertical: true) }
                                }
                            }.font(.system(size: 15)).padding(15).frame(maxWidth: .infinity, alignment: .leading)
                                .background(TodayPresentation.tint(card.style).opacity(0.18), in: RoundedRectangle(cornerRadius: 12))
                        }
                        ForEach(brief.sources.filter { card.sourceIds.contains($0.id) }) { source in
                            if exporting {
                                Text("↗ \(source.title) · \(TodayPresentation.timestamp(source.occurredAt, timeZone: brief.timeZone))").font(.caption).foregroundStyle(InstantStyle.muted)
                            } else {
                                Button { onSource?(source) } label: { Label(source.title, systemImage: "text.quote").font(.caption).frame(minHeight: 32) }
                                    .foregroundStyle(InstantStyle.forest).accessibilityIdentifier("today.source.\(source.recordId)")
                            }
                        }
                        ForEach(Array(card.links.enumerated()), id: \.offset) { _, link in
                            if let url = URL(string: link.url), url.scheme == "https" {
                                if exporting { Text("\(link.title) · \(url.host ?? "")").font(.caption).foregroundStyle(InstantStyle.muted) }
                                else { Link(destination: url) { Label(link.title, systemImage: "arrow.up.right").font(.caption).frame(minHeight: 32) }.foregroundStyle(InstantStyle.forest) }
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(22)
                        .background(InstantStyle.paperElevated, in: RoundedRectangle(cornerRadius: 20))
                        .overlay(alignment: .top) { RoundedRectangle(cornerRadius: 2).fill(TodayPresentation.tint(card.style)).frame(width: 42, height: 3).padding(.top, 1) }
                        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(InstantStyle.border, lineWidth: 0.7))
                }
                if let cutoff = brief.inputCutoff {
                    Text("Based on information available \(TodayPresentation.timestamp(cutoff, timeZone: brief.timeZone, includeTime: true)) · \(brief.timeZone)")
                        .font(.system(size: 10)).foregroundStyle(InstantStyle.muted).padding(.horizontal, 4)
                }
            } else {
                HStack(alignment: .top, spacing: 12) {
                    if ["pending", "generating"].contains(brief.status) { ProgressView().padding(.top, 3) }
                    VStack(alignment: .leading, spacing: 7) {
                        Text(statusTitle).font(InstantStyle.serif(22))
                        Text(statusDetail).font(.callout).foregroundStyle(InstantStyle.muted)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(22).background(InstantStyle.paperElevated, in: RoundedRectangle(cornerRadius: 20))
            }
        }.foregroundStyle(InstantStyle.ink)
    }
    private var statusTitle: String { switch brief.status { case "withdrawn": "This brief is no longer available"; case "failed": "This brief couldn't be finished"; default: "Your brief is taking shape" } }
    private var statusDetail: String { switch brief.status { case "withdrawn": "A source was removed or changed."; case "failed": "Your earlier briefs are still here. The next scheduled brief will run as usual."; default: "You can close the app. It will appear here when it's ready." } }
}

struct TodayCaptureRoute: Identifiable { let id = UUID(); let date: String }
struct TodaySourceRoute: Identifiable { let id = UUID(); let brief: TodayBrief; let source: TodaySource }
private struct TodaySourceView: View {
    @Environment(TodayModel.self) private var today
    @Environment(\.dismiss) private var dismiss
    let route: TodaySourceRoute
    @State private var text: String?
    @State private var error: String?
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(route.source.title).font(InstantStyle.serif(26))
                    Text(TodayPresentation.timestamp(route.source.occurredAt, timeZone: route.brief.timeZone, includeTime: true)).font(.caption).foregroundStyle(InstantStyle.muted)
                    if let text { Text(text).textSelection(.enabled).lineSpacing(5) }
                    else if let error { Text(error) } else { ProgressView() }
                }.padding(22).frame(maxWidth: .infinity, alignment: .leading)
            }.background(InstantStyle.paper).toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.task { do { text = try await today.source(for: route.brief, source: route.source).text } catch { self.error = "This source is unavailable. It may have been removed." } }
    }
}
