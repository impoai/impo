import SwiftUI

/// The same permission entry point is used in onboarding and Connections.
struct DeviceAccessCard: View {
    @Environment(AppModel.self) private var model
    let kind: String
    private var isCalendar: Bool { kind == "calendar" }
    private var enabled: Bool { isCalendar ? model.calendarEnabled : model.healthEnabled }
    private var busy: Bool { isCalendar ? model.deviceData.isRequestingCalendarAccess : model.deviceData.isRequestingHealthAccess }
    private var status: String {
        if isCalendar && !enabled && model.deviceData.canReadCalendar { return "Not enabled in Impo · permission available" }
        return isCalendar ? model.deviceData.calendarStatus : model.deviceData.healthStatus
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(spacing: 12) {
                Image(systemName: isCalendar ? "calendar" : "heart.fill")
                    .font(.system(size: 22)).foregroundStyle(isCalendar ? InstantStyle.accent : InstantStyle.forest)
                    .frame(width: 42, height: 42)
                    .background(InstantStyle.paperElevated, in: RoundedRectangle(cornerRadius: 11))
                    .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(InstantStyle.border, lineWidth: 0.75))
                Text(isCalendar ? "Apple Calendar" : "Apple Health").font(InstantStyle.serif(20))
                Spacer()
                if busy { ProgressView().controlSize(.small).tint(InstantStyle.forest) }
            }
            Text(isCalendar ? "Read events to help plan your day. Impo does not create or change events." : "Read the steps, active energy, heart rate and sleep data you choose to share. Impo does not write to Health.")
                .font(.system(size: 14)).foregroundStyle(InstantStyle.muted).lineSpacing(3)
            Text(status).font(.caption).foregroundStyle(InstantStyle.forest)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(InstantStyle.sage.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityIdentifier("connection.\(kind).status")
            HStack(spacing: 18) {
                Button(enabled ? "Review access" : "Connect") {
                    Task { await model.connectDeviceData(kind) }
                }
                .font(.system(size: 15, weight: .medium)).foregroundStyle(InstantStyle.forest)
                .padding(.horizontal, 18).padding(.vertical, 10).frame(minHeight: 44)
                .instantGlass(cornerRadius: 13, tint: InstantStyle.accent.opacity(0.24))
                .disabled(busy).accessibilityIdentifier("connection.\(kind)")
                if enabled {
                    Button("Disconnect") { model.disconnectDeviceData(kind) }
                        .font(.footnote).foregroundStyle(InstantStyle.muted)
                        .accessibilityIdentifier("connection.\(kind).disconnect")
                }
            }.buttonStyle(.plain)
            if !isCalendar {
                Text("Apple keeps read permission private. No returned data can mean no records or no access. Manage permissions in Health → your profile → Apps → Impo.")
                    .font(.caption).foregroundStyle(InstantStyle.muted).lineSpacing(2)
            }
        }
        .foregroundStyle(InstantStyle.ink)
        .padding(20).frame(maxWidth: .infinity, alignment: .leading)
        .paperSurface(cornerRadius: 18)
    }
}
