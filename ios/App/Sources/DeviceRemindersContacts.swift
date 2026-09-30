import Foundation
import EventKit
import Contacts
import InstantClient

/// Apple Reminders (read and create on request) and Apple Contacts (read-only search).
/// Inputs are validated again on the device; results carry provenance and truncation.
@MainActor
struct DeviceRemindersContacts {
    enum Failure: Error { case invalid(String), permissionRequired, listNotFound }

    let eventStore: EKEventStore

    static var canUseReminders: Bool { EKEventStore.authorizationStatus(for: .reminder) == .fullAccess }
    static var canReadContacts: Bool {
        let status = CNContactStore.authorizationStatus(for: .contacts)
        return status == .authorized || status == .limited
    }

    // MARK: Reminders

    func listReminders(_ input: JSONValue) async throws -> JSONValue {
        guard case .object(let fields) = input else { throw Failure.invalid("invalid_arguments") }
        guard Set(fields.keys).isSubset(of: ["status", "limit", "due_start", "due_end", "time_zone"]) else { throw Failure.invalid("invalid_arguments") }
        guard let status = fields["status"]?.string, ["incomplete", "completed", "all"].contains(status) else { throw Failure.invalid("invalid_arguments") }
        let limit = try Self.integer(fields["limit"], in: 1...100)
        let range = try Self.dueRange(fields)
        guard Self.canUseReminders else { throw Failure.permissionRequired }

        let predicate = status == "incomplete"
            ? eventStore.predicateForIncompleteReminders(withDueDateStarting: range?.start, ending: range?.end, calendars: nil)
            : eventStore.predicateForReminders(in: nil)
        // EventKit hands results back on its own queue; they are only read on the main actor afterwards.
        struct Fetched: @unchecked Sendable { let reminders: [EKReminder] }
        let fetched = await withCheckedContinuation { (continuation: CheckedContinuation<Fetched, Never>) in
            eventStore.fetchReminders(matching: predicate) { continuation.resume(returning: Fetched(reminders: $0 ?? [])) }
        }.reminders
        try Task.checkCancellation()
        guard Self.canUseReminders else { throw Failure.permissionRequired }
        let matching = fetched.filter { reminder in
            if status == "completed" && !reminder.isCompleted { return false }
            guard let range else { return true }
            guard let due = reminder.dueDateComponents?.date else { return false }
            return due >= range.start && due < range.end
        }.sorted { first, second in
            switch (first.dueDateComponents?.date, second.dueDateComponents?.date) {
            case let (a?, b?) where a != b: return a < b
            case (_?, nil): return true
            case (nil, _?): return false
            default: return first.calendarItemIdentifier < second.calendarItemIdentifier
            }
        }
        let returned = matching.prefix(limit)
        let textTruncated = returned.contains { ($0.title?.count ?? 0) > 300 || ($0.notes?.count ?? 0) > 500 || $0.calendar.title.count > 150 }
        var output = envelope(source: "ios.eventkit.reminders", truncated: matching.count > limit || textTruncated)
        if let range { output["due_range"] = .object(["start": .string(DeviceDataInput.timestamp(range.start)), "end": .string(DeviceDataInput.timestamp(range.end)), "interval": .string("[start,end)"), "timezone": .string(range.zone.identifier)]) }
        output["reminders"] = .array(returned.map(reminderJSON))
        output["returned_count"] = .number(Double(returned.count))
        return .object(output)
    }

    func createReminder(_ input: JSONValue) throws -> JSONValue {
        guard case .object(let fields) = input else { throw Failure.invalid("invalid_arguments") }
        guard Set(fields.keys).isSubset(of: ["title", "notes", "due", "time_zone", "list"]) else { throw Failure.invalid("invalid_arguments") }
        let title = try Self.text(fields["title"], maximum: 300)
        let notes = try fields["notes"].map { try Self.text($0, maximum: 2000) }
        let listName = try fields["list"].map { try Self.text($0, maximum: 150) }
        guard (fields["due"] == nil) == (fields["time_zone"] == nil) else { throw Failure.invalid("invalid_arguments") }
        guard Self.canUseReminders else { throw Failure.permissionRequired }

        let reminder = EKReminder(eventStore: eventStore)
        reminder.title = title
        reminder.notes = notes
        if let listName {
            guard let list = eventStore.calendars(for: .reminder).first(where: { $0.title.localizedCaseInsensitiveCompare(listName) == .orderedSame && $0.allowsContentModifications })
            else { throw Failure.listNotFound }
            reminder.calendar = list
        } else {
            guard let list = eventStore.defaultCalendarForNewReminders() else { throw Failure.listNotFound }
            reminder.calendar = list
        }
        if let rawDue = fields["due"]?.string, let rawZone = fields["time_zone"]?.string {
            guard let due = Self.date(rawDue), let zone = Self.zone(rawZone) else { throw Failure.invalid("invalid_date_range") }
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = zone
            var components = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: due)
            components.timeZone = zone
            reminder.dueDateComponents = components
            reminder.addAlarm(EKAlarm(absoluteDate: due))
        }
        try eventStore.save(reminder, commit: true)
        var output = envelope(source: "ios.eventkit.reminders", truncated: false)
        output["created"] = reminderJSON(reminder)
        return .object(output)
    }

    private func reminderJSON(_ reminder: EKReminder) -> JSONValue {
        let due = reminder.dueDateComponents
        return .object([
            "id": Self.bounded(reminder.calendarItemIdentifier, 512),
            "title": Self.bounded(reminder.title, 300),
            "notes": Self.bounded(reminder.notes, 500),
            "due": due?.date.map { .string(DeviceDataInput.timestamp($0)) } ?? .null,
            "due_all_day": due.map { .bool($0.hour == nil) } ?? .null,
            "completed": .bool(reminder.isCompleted),
            "completed_at": reminder.completionDate.map { .string(DeviceDataInput.timestamp($0)) } ?? .null,
            "priority": .number(Double(reminder.priority)),
            "list": Self.bounded(reminder.calendar?.title, 150),
        ])
    }

    // MARK: Contacts

    func searchContacts(_ input: JSONValue) async throws -> JSONValue {
        guard case .object(let fields) = input, Set(fields.keys) == ["query", "limit"] else { throw Failure.invalid("invalid_arguments") }
        let query = try Self.text(fields["query"], maximum: 100)
        let limit = try Self.integer(fields["limit"], in: 1...25)
        guard Self.canReadContacts else { throw Failure.permissionRequired }
        let (items, total) = try await Task.detached(priority: .userInitiated) { try Self.matchingContacts(query, limit: limit) }.value
        try Task.checkCancellation()
        var output = envelope(source: "ios.contacts", truncated: total > limit)
        output["contacts"] = .array(items)
        output["returned_count"] = .number(Double(items.count))
        output["notes_included"] = .bool(false)
        return .object(output)
    }

    /// Runs off the main actor; only Sendable JSON leaves it.
    nonisolated private static func contactJSON(_ contact: CNContact) -> JSONValue {
            .object([
                "id": Self.bounded(contact.identifier, 512),
                "name": Self.bounded(CNContactFormatter.string(from: contact, style: .fullName) ?? contact.nickname, 200),
                "nickname": contact.nickname.isEmpty ? .null : Self.bounded(contact.nickname, 100),
                "organization": contact.organizationName.isEmpty ? .null : Self.bounded(contact.organizationName, 150),
                "job_title": contact.jobTitle.isEmpty ? .null : Self.bounded(contact.jobTitle, 150),
                "phones": .array(contact.phoneNumbers.prefix(5).map { .object(["label": Self.label($0.label), "number": Self.bounded($0.value.stringValue, 64)]) }),
                "emails": .array(contact.emailAddresses.prefix(5).map { .object(["label": Self.label($0.label), "address": Self.bounded($0.value as String, 254)]) }),
                "birthday": contact.birthday.map(Self.birthday) ?? .null,
            ])
    }

    nonisolated private static func matchingContacts(_ query: String, limit: Int) throws -> ([JSONValue], Int) {
        let keys: [CNKeyDescriptor] = [
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
            CNContactNicknameKey as CNKeyDescriptor, CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactJobTitleKey as CNKeyDescriptor, CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor, CNContactBirthdayKey as CNKeyDescriptor,
        ]
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let digits = needle.filter(\.isNumber)
        var found: [CNContact] = []
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.sortOrder = .userDefault
        try CNContactStore().enumerateContacts(with: request) { contact, stop in
            let name = [contact.givenName, contact.middleName, contact.familyName, contact.nickname].joined(separator: " ")
            let hit = name.localizedCaseInsensitiveContains(needle)
                || contact.organizationName.localizedCaseInsensitiveContains(needle)
                || contact.emailAddresses.contains { ($0.value as String).localizedCaseInsensitiveContains(needle) }
                || (digits.count >= 4 && contact.phoneNumbers.contains { $0.value.stringValue.filter(\.isNumber).contains(digits) })
            if hit { found.append(contact) }
            if found.count > 200 { stop.pointee = true }
        }
        return (found.prefix(limit).map(contactJSON), found.count)
    }

    // MARK: Helpers

    private func envelope(source: String, truncated: Bool) -> [String: JSONValue] {
        ["source": .string(source), "observed_at": .string(DeviceDataInput.timestamp(Date())), "truncated": .bool(truncated)]
    }

    private static func dueRange(_ fields: [String: JSONValue]) throws -> (start: Date, end: Date, zone: TimeZone)? {
        let keys = ["due_start", "due_end", "time_zone"].filter { fields[$0] != nil }
        if keys.isEmpty { return nil }
        guard keys.count == 3, let start = fields["due_start"]?.string.flatMap(date), let end = fields["due_end"]?.string.flatMap(date),
              let zone = fields["time_zone"]?.string.flatMap(zone), start < end, end.timeIntervalSince(start) <= 366 * 86_400
        else { throw Failure.invalid("invalid_date_range") }
        return (start, end, zone)
    }

    private static func date(_ raw: String) -> Date? {
        guard raw.count <= 40 else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = raw.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        return formatter.date(from: raw)
    }

    private static func zone(_ raw: String) -> TimeZone? {
        guard raw.count <= 100, TimeZone.knownTimeZoneIdentifiers.contains(raw) || ["UTC", "GMT"].contains(raw) else { return nil }
        return TimeZone(identifier: raw)
    }

    private static func integer(_ value: JSONValue?, in range: ClosedRange<Int>) throws -> Int {
        guard case .number(let number)? = value, number.isFinite, number.rounded(.towardZero) == number, range.contains(Int(number)) else { throw Failure.invalid("invalid_limit") }
        return Int(number)
    }

    private static func text(_ value: JSONValue?, maximum: Int) throws -> String {
        guard let raw = value?.string, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, raw.count <= maximum, !raw.contains("\0") else { throw Failure.invalid("invalid_arguments") }
        return raw
    }

    nonisolated private static func bounded(_ value: String?, _ maximum: Int) -> JSONValue {
        value.map { .string(String($0.replacingOccurrences(of: "\0", with: "").prefix(maximum))) } ?? .null
    }

    nonisolated private static func label(_ raw: String?) -> JSONValue {
        guard let raw else { return .null }
        return bounded(CNLabeledValue<NSString>.localizedString(forLabel: raw), 50)
    }

    nonisolated private static func birthday(_ components: DateComponents) -> JSONValue {
        guard let month = components.month, let day = components.day else { return .null }
        if let year = components.year { return .string(String(format: "%04d-%02d-%02d", year, month, day)) }
        return .string(String(format: "--%02d-%02d", month, day))
    }
}
