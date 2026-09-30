import SwiftUI

/// The same permission entry point is used in onboarding and Connections.
struct DeviceAccessCard: View {
    @Environment(AppModel.self) private var model
    let kind: String

    private var enabled: Bool {
        switch kind {
        case "calendar": model.calendarEnabled
        case "reminders": model.remindersEnabled
        case "contacts": model.contactsEnabled
        default: model.healthEnabled
        }
    }
    private var busy: Bool {
        let data = model.deviceData
        switch kind {
        case "calendar": return data.isRequestingCalendarAccess
        case "reminders": return data.isRequestingRemindersAccess
        case "contacts": return data.isRequestingContactsAccess
        default: return data.isRequestingHealthAccess
        }
    }
    private var permissionAvailable: Bool {
        switch kind {
        case "calendar": model.deviceData.canReadCalendar
        case "reminders": model.deviceData.canUseReminders
        case "contacts": model.deviceData.canReadContacts
        default: false
        }
    }
    private var status: String {
        if !enabled && permissionAvailable { return "Not enabled in Impo · permission available" }
        switch kind {
        case "calendar": return model.deviceData.calendarStatus
        case "reminders": return model.deviceData.remindersStatus
        case "contacts": return model.deviceData.contactsStatus
        default: return model.deviceData.healthStatus
        }
    }
    private var title: String {
        switch kind {
        case "calendar": "Apple Calendar"
        case "reminders": "Apple Reminders"
        case "contacts": "Apple Contacts"
        default: "Apple Health"
        }
    }
    private var symbol: String {
        switch kind {
        case "calendar": "calendar"
        case "reminders": "checklist"
        case "contacts": "person.crop.circle"
        default: "heart.fill"
        }
    }
    private var summary: String {
        switch kind {
        case "calendar": "Read events to help plan your day. Impo does not create or change events."
        case "reminders": "Read your reminders, and add one when you ask. Impo does not change or delete existing reminders."
        case "contacts": "Look up people you ask about. Impo does not change your contacts."
        default: "Read the steps, active energy, heart rate and sleep data you choose to share. Impo does not write to Health."
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(spacing: 12) {
                Image(systemName: symbol)
                    .font(.system(size: 22)).foregroundStyle(kind == "health" ? InstantStyle.forest : InstantStyle.accent)
                    .frame(width: 42, height: 42)
                    .background(InstantStyle.paperElevated, in: RoundedRectangle(cornerRadius: 11))
                    .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(InstantStyle.border, lineWidth: 0.75))
                Text(title).font(InstantStyle.serif(20))
                Spacer()
                if busy { ProgressView().controlSize(.small).tint(InstantStyle.forest) }
            }
            Text(summary)
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
            if kind == "health" {
                Text("Apple keeps read permission private. No returned data can mean no records or no access. Manage permissions in Health → your profile → Apps → Impo.")
                    .font(.caption).foregroundStyle(InstantStyle.muted).lineSpacing(2)
            }
        }
        .foregroundStyle(InstantStyle.ink)
        .padding(20).frame(maxWidth: .infinity, alignment: .leading)
        .paperSurface(cornerRadius: 18)
    }
}
