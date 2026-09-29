import Foundation
import UIKit
@preconcurrency import CoreLocation

@MainActor protocol EchoLocationReading: AnyObject {
    var history: EchoLocationHistory { get }
    var status: String { get }
    func prepare()
    func start(requestPermission: Bool)
    func stop()
}

/// Standard location updates are active only while Echo's microphone is active.
@MainActor final class EchoLocationReader: NSObject, EchoLocationReading, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let geocoder = CLGeocoder()
    private var active = false
    private var generation = UUID()
    private var lookup: Task<Void, Never>?
    private var lastLookup = Date.distantPast
    private var cached: (coordinate: CLLocation, city: String, country: String, district: String?)?
    private(set) var history = EchoLocationHistory()
    private(set) var status = "Location is added while Echo records."

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.distanceFilter = kCLDistanceFilterNone
        manager.pausesLocationUpdatesAutomatically = false
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
    }

    func prepare() {
        stop()
        history = EchoLocationHistory()
    }

    func start(requestPermission: Bool) {
        active = true
        if manager.authorizationStatus == .notDetermined, requestPermission, UIApplication.shared.applicationState == .active {
            status = "Choose whether to add places to Echo."
            manager.requestWhenInUseAuthorization()
        } else { updateAuthorization() }
    }

    func stop() {
        history.pause()
        active = false; generation = UUID()
        manager.stopUpdatingLocation(); lookup?.cancel(); lookup = nil
        geocoder.cancelGeocode(); cached = nil; lastLookup = .distantPast
        status = "Location is added while Echo records."
        updateAuthorization()
        // The finishing audio writer still owns this history until its final checkpoint.
    }

    private func updateAuthorization() {
        guard active else {
            if manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted {
                status = "Location is off in iPhone Settings. Echo can still record."
            }
            return
        }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            status = "Finding the recording location…"; manager.startUpdatingLocation()
        case .denied, .restricted:
            history.pause()
            manager.stopUpdatingLocation(); lookup?.cancel(); lookup = nil; geocoder.cancelGeocode()
            generation = UUID(); cached = nil
            status = "Location is off in iPhone Settings. Echo can still record."
        default: status = ""
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { updateAuthorization() }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // A missing fix is not worth announcing; recording continues without location.
        guard active else { return }
        status = ""
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard active, manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways,
              let fix = locations.last, fix.horizontalAccuracy >= 0, fix.horizontalAccuracy <= 5000,
              fix.timestamp <= Date(), Date().timeIntervalSince(fix.timestamp) <= 60 else { return }
        if let cached, (cached.coordinate.horizontalAccuracy <= 500 || fix.horizontalAccuracy > 500), fix.distance(from: cached.coordinate) <= (cached.district == nil ? 500 : 100) {
            record(fix, city: cached.city, country: cached.country, district: cached.district)
            return
        }
        guard lookup == nil, Date().timeIntervalSince(lastLookup) >= 30 else { return }
        lastLookup = Date()
        let token = generation
        lookup = Task { [weak self] in
            guard let self else { return }
            defer { if generation == token { lookup = nil } }
            do {
                let places = try await geocoder.reverseGeocodeLocation(fix, preferredLocale: Locale(identifier: "en_US"))
                guard active, generation == token, !Task.isCancelled, let place = places.first,
                      let city = place.locality ?? place.administrativeArea, let country = place.country else { return }
                let district = fix.horizontalAccuracy <= 500 ? place.subLocality : nil
                cached = (fix, String(city.prefix(100)), String(country.prefix(100)), district.map { String($0.prefix(100)) })
                record(fix, city: cached!.city, country: cached!.country, district: cached!.district)
            } catch {
                if active, generation == token { status = "" }
            }
        }
    }
    private func record(_ fix: CLLocation, city: String, country: String, district: String?) {
        let district = fix.horizontalAccuracy <= 500 ? district : nil
        history.add(.init(capturedAt: fix.timestamp, accuracyMeters: fix.horizontalAccuracy, city: city, country: country, district: district))
        status = "Near " + [district, city].compactMap { $0 }.joined(separator: ", ")
    }
}

/// Isolated recording tests inject a reader; a temporary audio store never requests device location.
@MainActor final class UnavailableEchoLocationReader: EchoLocationReading {
    private(set) var history = EchoLocationHistory()
    var status: String { "" }
    func prepare() { history = EchoLocationHistory() }
    func start(requestPermission: Bool) {}
    func stop() {}
}
