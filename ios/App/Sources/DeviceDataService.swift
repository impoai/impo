import Foundation
import Observation
import EventKit
import HealthKit
import InstantClient

/// Read-only device tools. Permission requests run only from an explicit UI action.
@MainActor @Observable
final class DeviceDataService {
    private(set) var calendarStatus = "Not connected"
    private(set) var healthStatus = "Permission not requested"
    private(set) var healthAccessRequested = false
    private(set) var isRequestingCalendarAccess = false
    private(set) var isRequestingHealthAccess = false

    @ObservationIgnored private let eventStore = EKEventStore()
    @ObservationIgnored private var healthStore: HKHealthStore?
    @ObservationIgnored private let defaults: UserDefaults
    private static let healthReviewKey = "instant.healthPermissionReviewed.v1"
    private static let sleepSampleLimit = 200

    var canReadCalendar: Bool { EKEventStore.authorizationStatus(for: .event) == .fullAccess }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        refreshAuthorizationStatus()
    }

    /// Refresh after returning from iOS Settings. Health read authorization is
    /// intentionally opaque; a reviewed sheet is never reported as a read grant.
    func refreshAuthorizationStatus() {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: calendarStatus = "Connected · read-only in Impo"
        case .denied: calendarStatus = "Access denied · review in Settings"
        case .restricted: calendarStatus = "Access restricted by iOS"
        case .writeOnly: calendarStatus = "Full access required to read events"
        case .notDetermined: calendarStatus = "Not connected"
        @unknown default: calendarStatus = "Calendar permission unknown"
        }
        healthAccessRequested = defaults.bool(forKey: Self.healthReviewKey)
        if !HKHealthStore.isHealthDataAvailable() { healthStatus = "Health data unavailable on this device" }
        else if healthAccessRequested { healthStatus = "Permission reviewed · data availability unknown" }
        else { healthStatus = "Permission not requested" }
    }

    func requestCalendarAccess() async {
        guard !isRequestingCalendarAccess else { return }
        isRequestingCalendarAccess = true
        defer { isRequestingCalendarAccess = false }
        do {
            _ = try await eventStore.requestFullAccessToEvents()
            refreshAuthorizationStatus()
        } catch { calendarStatus = "Couldn't request Calendar access · try again" }
    }

    func requestHealthAccess() async {
        guard !isRequestingHealthAccess else { return }
        guard HKHealthStore.isHealthDataAvailable() else { refreshAuthorizationStatus(); return }
        isRequestingHealthAccess = true
        defer { isRequestingHealthAccess = false }
        do {
            let store = availableHealthStore()
            let read: Set<HKObjectType> = [
                HKQuantityType(.stepCount), HKQuantityType(.activeEnergyBurned),
                HKQuantityType(.heartRate), HKCategoryType(.sleepAnalysis)
            ]
            try await store.requestAuthorization(toShare: [], read: read)
            // This records completion of the request, not granted read access.
            defaults.set(true, forKey: Self.healthReviewKey)
            refreshAuthorizationStatus()
        } catch { healthStatus = "Couldn't review Health permissions · try again" }
    }

    func execute(toolName: String, input: JSONValue) async -> DeviceToolExecutionResult {
        do {
            try Task.checkCancellation()
            switch toolName {
            case "ios_list_calendar_events":
                let arguments = try DeviceDataInput(input, health: false)
                refreshAuthorizationStatus()
                guard canReadCalendar else { return failure("permission_required") }
                return DeviceToolExecutionResult(success: true, output: try DeviceDataOutputBudget.bound(calendarEvents(arguments)))
            case "ios_get_health_summary":
                let arguments = try DeviceDataInput(input, health: true)
                refreshAuthorizationStatus()
                guard HKHealthStore.isHealthDataAvailable() else { return failure("health_unavailable") }
                guard healthAccessRequested else { return failure("permission_required") }
                let output = try await healthSummary(arguments)
                return DeviceToolExecutionResult(success: true, output: try DeviceDataOutputBudget.bound(output))
            default: return failure("unsupported_tool")
            }
        } catch let invalid as DeviceDataInput.Invalid { return failure(invalid.code) }
        catch DeviceDataOutputBudget.Failure.tooLarge { return failure("result_too_large") }
        catch NativeReadError.permissionRevoked { return failure("permission_required") }
        catch is CancellationError { return failure("cancelled") }
        catch {
            // Do not transmit localized OS errors, database paths, or raw health data.
            let code = (error as NSError).code
            if (error as NSError).domain == HKErrorDomain && code == HKError.Code.errorAuthorizationNotDetermined.rawValue {
                return failure("permission_required")
            }
            return failure("device_data_unavailable")
        }
    }

    private func failure(_ code: String) -> DeviceToolExecutionResult {
        DeviceToolExecutionResult(success: false, error: code)
    }

    private func availableHealthStore() -> HKHealthStore {
        if let healthStore { return healthStore }
        let store = HKHealthStore()
        healthStore = store
        return store
    }

    private func envelope(_ input: DeviceDataInput, source: String, truncated: Bool) -> [String: JSONValue] {
        ["source": .string(source), "observed_at": .string(DeviceDataInput.timestamp(Date())),
         "timezone": .string(input.timezone.identifier), "range": input.rangeJSON, "truncated": .bool(truncated)]
    }

    private func calendarEvents(_ input: DeviceDataInput) throws -> JSONValue {
        let predicate = eventStore.predicateForEvents(withStart: input.start, end: input.end, calendars: nil)
        let events = eventStore.events(matching: predicate).filter { event in
            guard let start = event.startDate, let end = event.endDate else { return false }
            return input.overlaps(start: start, end: end)
        }.sorted { first, second in
            if first.startDate != second.startDate { return first.startDate < second.startDate }
            return (first.eventIdentifier ?? "") < (second.eventIdentifier ?? "")
        }
        try Task.checkCancellation()
        // Re-check revocation after the synchronous EventKit read.
        guard canReadCalendar else { throw NativeReadError.permissionRevoked }
        let textTruncated = events.prefix(input.limit).contains { event in
            (event.title?.count ?? 0) > 300 || (event.location?.count ?? 0) > 300
                || (event.eventIdentifier?.count ?? 0) > 512 || (event.calendar?.title.count ?? 0) > 150
                || (event.calendar?.source?.title.count ?? 0) > 150
        }
        var output = envelope(input, source: "ios.eventkit", truncated: events.count > input.limit || textTruncated)
        output["events"] = .array(events.prefix(input.limit).map { event in
            .object([
                "id": text(event.eventIdentifier, maximum: 512),
                "title": text(event.title, maximum: 300),
                "start": .string(DeviceDataInput.timestamp(event.startDate)),
                "end": .string(DeviceDataInput.timestamp(event.endDate)),
                "overlap_start": .string(DeviceDataInput.timestamp(max(event.startDate, input.start))),
                "overlap_end": .string(DeviceDataInput.timestamp(min(event.endDate, input.end))),
                "all_day": .bool(event.isAllDay),
                "calendar": text(event.calendar?.title, maximum: 150),
                "source": text(event.calendar?.source?.title, maximum: 150),
                "event_timezone": event.timeZone.map { .string($0.identifier) } ?? .null,
                "location": text(event.location, maximum: 300)
            ])
        })
        output["returned_count"] = .number(Double(min(events.count, input.limit)))
        output["notes_included"] = .bool(false)
        output["text_fields_truncated"] = .bool(textTruncated)
        return .object(output)
    }

    private func healthSummary(_ input: DeviceDataInput) async throws -> JSONValue {
        let store = availableHealthStore()
        var metrics: [String: JSONValue] = [:]
        var truncated = false
        for metric in input.metrics {
            try Task.checkCancellation()
            let result: (JSONValue, Bool)
            switch metric {
            case .steps:
                result = try await quantitySummary(.stepCount, unit: .count(), unitName: "count", cumulative: true, input: input, store: store)
            case .active_energy:
                result = try await quantitySummary(.activeEnergyBurned, unit: .kilocalorie(), unitName: "kcal", cumulative: true, input: input, store: store)
            case .heart_rate:
                result = try await quantitySummary(.heartRate, unit: .count().unitDivided(by: .minute()), unitName: "beats/min", cumulative: false, input: input, store: store)
            case .sleep:
                result = try await sleepSamples(input, store: store)
            }
            try Task.checkCancellation()
            metrics[metric.rawValue] = result.0
            truncated = truncated || result.1
        }
        var output = envelope(input, source: "ios.healthkit", truncated: truncated)
        output["metrics"] = .object(metrics)
        output["read_authorization"] = .string("unknown")
        output["availability_note"] = .string("Missing results mean unknown availability: no samples, denied or limited read access, or unsynced data. Null never means zero activity.")
        return .object(output)
    }

    private func quantitySummary(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, unitName: String,
                                 cumulative: Bool, input: DeviceDataInput, store: HKHealthStore) async throws -> (JSONValue, Bool) {
        // Exclude samples spanning a boundary instead of attributing their full
        // quantity to this range. Include samples ending exactly at end.
        let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
            HKQuery.predicateForSamples(withStart: input.start, end: input.end, options: .strictStartDate),
            NSPredicate(format: "%K < %@ AND %K <= %@", HKPredicateKeyPathStartDate, input.end as NSDate, HKPredicateKeyPathEndDate, input.end as NSDate)
        ])
        let descriptor = HKStatisticsQueryDescriptor(
            predicate: .quantitySample(type: HKQuantityType(identifier), predicate: predicate),
            options: cumulative ? .cumulativeSum : [.discreteAverage, .discreteMin, .discreteMax]
        )
        let statistics: HKStatistics?
        do { statistics = try await descriptor.result(for: store) }
        catch where isNoHealthData(error) { statistics = nil }
        let sources = (statistics?.sources ?? []).sorted { $0.bundleIdentifier < $1.bundleIdentifier }
        var output: [String: JSONValue] = [
            "unit": .string(unitName), "method": .string("HealthKit statistics; merged sources, not per-source sums"),
            "boundary_policy": .string("Only samples fully contained in [start,end); boundary-spanning samples excluded"),
            "sources": .array(sources.prefix(20).map { .object(["name": text($0.name, maximum: 150), "bundle_id": text($0.bundleIdentifier, maximum: 256)]) })
        ]
        let quantity = cumulative ? statistics?.sumQuantity() : statistics?.averageQuantity()
        output["availability"] = .string(quantity == nil ? "unknown" : "observed")
        if cumulative { output["value"] = number(quantity?.doubleValue(for: unit)) }
        else {
            output["average"] = number(quantity?.doubleValue(for: unit))
            output["minimum"] = number(statistics?.minimumQuantity()?.doubleValue(for: unit))
            output["maximum"] = number(statistics?.maximumQuantity()?.doubleValue(for: unit))
        }
        output["truncated"] = .bool(sources.count > 20)
        return (.object(output), sources.count > 20)
    }

    private func sleepSamples(_ input: DeviceDataInput, store: HKHealthStore) async throws -> (JSONValue, Bool) {
        let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
            HKQuery.predicateForSamples(withStart: input.start, end: input.end, options: []),
            NSPredicate(format: "%K < %@ AND %K > %@", HKPredicateKeyPathStartDate, input.end as NSDate, HKPredicateKeyPathEndDate, input.start as NSDate)
        ])
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.categorySample(type: HKCategoryType(.sleepAnalysis), predicate: predicate)],
            sortDescriptors: [SortDescriptor(\.startDate, order: .reverse)], limit: Self.sleepSampleLimit + 1
        )
        let samples: [HKCategorySample]
        do { samples = try await descriptor.result(for: store) }
        catch where isNoHealthData(error) { samples = [] }
        let visible = samples.filter { input.overlaps(start: $0.startDate, end: $0.endDate) && $0.startDate < $0.endDate }
        let truncated = samples.count > Self.sleepSampleLimit
        return (.object([
            "availability": .string(visible.isEmpty ? "unknown" : "observed"),
            "samples": .array(visible.prefix(Self.sleepSampleLimit).map { sample in
                .object([
                    "start": .string(DeviceDataInput.timestamp(max(sample.startDate, input.start))),
                    "end": .string(DeviceDataInput.timestamp(min(sample.endDate, input.end))),
                    "stage": .string(sleepStage(sample.value)),
                    "source": .object(["name": text(sample.sourceRevision.source.name, maximum: 150), "bundle_id": text(sample.sourceRevision.source.bundleIdentifier, maximum: 256)])
                ])
            }),
            "total_sleep_seconds": .null, "truncated": .bool(truncated),
            "returned_sample_count": .number(Double(min(visible.count, Self.sleepSampleLimit))),
            "method": .string("Newest samples, clipped to [start,end). Stages and sources can overlap. Do not sum durations; no sleep total is computed.")
        ]), truncated)
    }

    private func sleepStage(_ value: Int) -> String {
        switch HKCategoryValueSleepAnalysis(rawValue: value) {
        case .inBed: "in_bed"
        case .awake: "awake"
        case .asleepUnspecified: "asleep_unspecified"
        case .asleepCore: "asleep_core"
        case .asleepDeep: "asleep_deep"
        case .asleepREM: "asleep_rem"
        default: "unknown"
        }
    }

    private func text(_ value: String?, maximum: Int) -> JSONValue {
        value.map { .string(String($0.replacingOccurrences(of: "\0", with: "").prefix(maximum))) } ?? .null
    }

    private func number(_ value: Double?) -> JSONValue {
        guard let value, value.isFinite else { return .null }
        return .number(value)
    }

    private func isNoHealthData(_ error: any Error) -> Bool {
        (error as NSError).domain == HKErrorDomain && (error as NSError).code == HKError.Code.errorNoData.rawValue
    }

    private enum NativeReadError: Error { case permissionRevoked }
}
