import Foundation
import InstantClient
@preconcurrency import CoreLocation

@MainActor final class TodayCityReader: NSObject, CityPermissionReading, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let geocoder = CLGeocoder()
    private var pending: CheckedContinuation<TodayLocation, Error>?
    private var timeout: Task<Void, Never>?
    private var requestID: UUID?
    private var readingLocation = false
    var authorization: CityPermission {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse: .authorized
        case .denied: .denied
        case .restricted: .restricted
        default: .notDetermined
        }
    }
    override init() { super.init(); manager.delegate = self; manager.desiredAccuracy = kCLLocationAccuracyThreeKilometers }
    func read(requestPermission: Bool) async throws -> TodayLocation {
        guard pending == nil else { throw CityError.unavailable }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                pending = continuation; requestID = id
                switch authorization {
                case .notDetermined:
                    if requestPermission { manager.requestWhenInUseAuthorization() }
                    else { finish(.failure(CityError.denied)) }
                case .authorized: requestCity()
                case .denied, .restricted: finish(.failure(CityError.denied))
                }
            }
        } onCancel: { Task { @MainActor in if self.requestID == id { self.cancel() } } }
    }
    private func requestCity() {
        guard pending != nil, !readingLocation else { return }
        readingLocation = true
        timeout = Task { try? await Task.sleep(for: .seconds(25)); if !Task.isCancelled { finish(.failure(CityError.unavailable)) } }
        manager.requestLocation()
    }
    func cancel() { finish(.failure(CancellationError())) }
    private func finish(_ result: Result<TodayLocation, Error>) {
        let continuation = pending; pending = nil; requestID = nil; readingLocation = false
        timeout?.cancel(); timeout = nil; manager.stopUpdatingLocation(); geocoder.cancelGeocode()
        continuation?.resume(with: result)
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard pending != nil else { return }
        switch authorization {
        case .authorized: requestCity()
        case .denied, .restricted: finish(.failure(CityError.denied))
        case .notDetermined: break
        }
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { finish(.failure(CityError.unavailable)) }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last, let id = requestID, location.horizontalAccuracy >= 0,
              abs(location.timestamp.timeIntervalSinceNow) < 300, !geocoder.isGeocoding else { return }
        Task {
            do {
                let places = try await geocoder.reverseGeocodeLocation(location)
                guard requestID == id else { return }
                guard let place = places.first, let city = place.locality ?? place.administrativeArea else { throw CityError.unavailable }
                finish(.success(TodayLocation(city: city, country: place.country ?? "", capturedAt: ISO8601DateFormatter().string(from: location.timestamp), source: .device)))
            } catch { if requestID == id { finish(.failure(CityError.unavailable)) } }
        }
    }
    enum CityError: Error { case denied, unavailable }
}
