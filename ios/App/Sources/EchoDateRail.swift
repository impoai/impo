import SwiftUI
import InstantClient

enum EchoDates {
    static var calendar: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = .current; return c }
    static func date(_ key: String) -> Date? {
        let p = key.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: p[0], month: p[1], day: p[2]))
    }
    static func key(_ date: Date) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 1970, c.month ?? 1, c.day ?? 1)
    }
    static func label(_ key: String, month: Bool = false) -> String {
        guard let date = date(key) else { return key }
        return month ? date.formatted(.dateTime.month(.abbreviated).year()) : date.formatted(.dateTime.month(.abbreviated).day().year())
    }
    static func months(_ days: [ListeningDay]) -> [ListeningDay] {
        var seen = Set<String>()
        return days.filter { seen.insert(String($0.date.prefix(7))).inserted }
    }
}

struct EchoDateRail: View {
    let days: [ListeningDay]
    let visibleDate: String?
    let jump: (String) -> Void
    @State private var byMonth = true
    @State private var dragging: Int?
    private var stops: [ListeningDay] { byMonth ? EchoDates.months(days) : days }
    private var selected: Int {
        if let dragging { return min(dragging, max(0, stops.count - 1)) }
        guard let visibleDate else { return 0 }
        return stops.firstIndex { byMonth ? $0.date.prefix(7) <= visibleDate.prefix(7) : $0.date <= visibleDate } ?? max(0, stops.count - 1)
    }
    var body: some View {
        VStack(spacing: 10) {
            Menu {
                Button("By month") { byMonth = true }.accessibilityIdentifier("echo.rail.months")
                Button("By day") { byMonth = false }.accessibilityIdentifier("echo.rail.days")
            } label: {
                VStack(spacing: 3) {
                    Text(byMonth ? "Month" : "Day").font(.system(size: 10, weight: .medium))
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
                }.frame(width: 48, height: 44).contentShape(Rectangle())
            }.accessibilityLabel("Date navigation: \(byMonth ? "months" : "days")")
                .accessibilityIdentifier("echo.rail.granularity")
            GeometryReader { geometry in
                let travel = max(1, geometry.size.height - 44)
                let position = CGFloat(selected) / CGFloat(max(1, stops.count - 1)) * travel
                ZStack(alignment: .topTrailing) {
                    Capsule().fill(InstantStyle.border.opacity(0.6)).frame(width: 2)
                        .padding(.vertical, 22).padding(.trailing, 23)
                    ForEach(Array(tickIndexes.enumerated()), id: \.offset) { _, i in
                        Circle().fill(InstantStyle.forest.opacity(0.35)).frame(width: 4, height: 4)
                            .offset(x: -22, y: CGFloat(i) / CGFloat(max(1, stops.count - 1)) * travel + 20)
                    }
                    Capsule().fill(InstantStyle.forest).frame(width: 6, height: 32)
                        .overlay(Image(systemName: "arrow.up.and.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(InstantStyle.paper).opacity(dragging == nil ? 0 : 1))
                        .frame(width: 44, height: 44).offset(x: -2, y: position)
                    if let stop = stops[safe: selected] {
                        Text(EchoDates.label(stop.date, month: byMonth))
                            .font(.system(size: dragging == nil ? 10 : 15, weight: .semibold)).monospacedDigit()
                            .foregroundStyle(dragging == nil ? InstantStyle.muted : InstantStyle.paper)
                            .padding(.horizontal, dragging == nil ? 0 : 14).padding(.vertical, 11)
                            .background(dragging == nil ? Color.clear : InstantStyle.forest, in: Capsule())
                            .fixedSize().offset(x: dragging == nil ? -36 : -48, y: position + 2)
                            .allowsHitTesting(false)
                    }
                }.frame(width: 48, height: geometry.size.height, alignment: .topTrailing)
                    .contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            let fraction = min(1, max(0, (value.location.y - 22) / travel))
                            let next = Int((fraction * CGFloat(max(0, stops.count - 1))).rounded())
                            if next != dragging { UISelectionFeedbackGenerator().selectionChanged() }
                            dragging = next
                        }
                        .onEnded { _ in
                            if let index = dragging, let stop = stops[safe: index] { jump(stop.date) }
                            dragging = nil
                        })
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Echo date scrubber")
                    .accessibilityValue(stops[safe: selected].map { EchoDates.label($0.date, month: byMonth) } ?? "No dates")
                    .accessibilityHint("Swipe up or down to move through \(byMonth ? "months" : "days")")
                    .accessibilityAdjustableAction { direction in
                        let next = min(max(0, selected + (direction == .increment ? 1 : -1)), max(0, stops.count - 1))
                        if let stop = stops[safe: next] { jump(stop.date) }
                    }
                    .accessibilityIdentifier("echo.date-rail")
            }
        }.foregroundStyle(InstantStyle.forest).frame(width: 48).padding(.vertical, 12)
    }
    private var tickIndexes: [Int] {
        guard !stops.isEmpty else { return [] }
        return Array(Set((0..<min(7, stops.count)).map { Int((Double($0) / Double(max(1, min(7, stops.count) - 1)) * Double(stops.count - 1)).rounded()) })).sorted()
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

struct EchoDateBrowser: View {
    let days: [ListeningDay]
    let jump: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Button("Back to latest") { jump(""); dismiss() }.foregroundStyle(InstantStyle.forest)
                ForEach(EchoDates.months(days)) { month in
                    Section(EchoDates.label(month.date, month: true)) {
                        ForEach(days.filter { $0.date.prefix(7) == month.date.prefix(7) }) { day in
                            Button { jump(day.date); dismiss() } label: {
                                HStack {
                                    Text(EchoDates.label(day.date))
                                    Spacer()
                                    Text("\(day.count)").foregroundStyle(InstantStyle.muted).monospacedDigit()
                                }.foregroundStyle(InstantStyle.ink)
                            }.accessibilityIdentifier("echo.date.\(day.date)")
                        }
                    }
                }
            }.scrollContentBackground(.hidden).background(InstantStyle.paper)
                .navigationTitle("Find a day").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.tint(InstantStyle.forest)
    }
}
