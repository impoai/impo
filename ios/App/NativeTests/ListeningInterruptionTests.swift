import AVFoundation
import Foundation
import InstantClient
import XCTest
@testable import Instant

@MainActor
final class ListeningInterruptionTests: XCTestCase {
    private var root: URL!
    private var model: ListeningModel!
    private var captures: [ControlledCapture] = []
    private var foreground = true
    private var blockNextStart = false
    private var failNextStart = false
    private var failuresRemaining = 0
    private var locations = ControlledEchoLocationReader()

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        locations = ControlledEchoLocationReader()
        captures = []; foreground = true; blockNextStart = false; failNextStart = false; failuresRemaining = 0
        makeModel()
    }

    private func makeModel(observeAudio: Bool = false, retryDelays: [Duration] = [.seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(15), .seconds(30)]) {
        model = ListeningModel(storageRoot: root, captureFactory: { [unowned self] _, update in
            let capture = ControlledCapture(blockStart: self.blockNextStart, failStart: self.failNextStart || self.failuresRemaining > 0, update: update)
            self.failuresRemaining = max(0, self.failuresRemaining - 1)
            self.blockNextStart = false; self.failNextStart = false
            self.captures.append(capture)
            return capture
        }, requestPermission: { true }, isAppActive: { [unowned self] in self.foreground }, locationReader: locations, observeAudio: observeAudio, observeNetwork: false, resumeRetryDelays: retryDelays)
        model.configure(scope: "interruption-test", client: client())
    }

    override func tearDown() async throws {
        model.stop()
        for capture in captures { capture.releaseStart(); capture.releaseStop() }
        try await eventually { !self.model.isFinishing }
        model = nil
        try? FileManager.default.removeItem(at: root)
    }

    func testLocationFollowsCapturePermissionToggleInterruptionAndAccountChange() async throws {
        model.locationEnabled = false
        try await begin()
        XCTAssertEqual(locations.requests, [])
        XCTAssertTrue(model.isRecording, "Audio works without location")
        model.locationEnabled = true
        XCTAssertEqual(locations.requests, [true])
        let stopped = locations.stops
        model.audioInterrupted()
        XCTAssertGreaterThan(locations.stops, stopped)
        foreground = false
        model.audioInterruptionEnded(shouldResume: true)
        try await eventually { self.model.isRecording }
        XCTAssertEqual(locations.requests, [true, false], "Background resume never asks for new permission")
        let stoppedAgain = locations.stops
        model.configure(scope: "another-location-user", client: client())
        XCTAssertGreaterThan(locations.stops, stoppedAgain)
        XCTAssertFalse(model.isRecording)
    }

    func testLegacySystemNotificationAdapterPausesAndResumes() async throws {
        if #available(iOS 27.0, *) { throw XCTSkip("Legacy notifications are only used before iOS 27") }
        makeModel(observeAudio: true)
        try await begin()
        NotificationCenter.default.post(name: AVAudioSession.interruptionNotification, object: AVAudioSession.sharedInstance(),
            userInfo: [AVAudioSessionInterruptionTypeKey: NSNumber(value: AVAudioSession.InterruptionType.began.rawValue)])
        try await eventually { self.model.isListening && !self.model.isRecording }
        foreground = false
        NotificationCenter.default.post(name: AVAudioSession.interruptionNotification, object: AVAudioSession.sharedInstance(),
            userInfo: [AVAudioSessionInterruptionTypeKey: NSNumber(value: AVAudioSession.InterruptionType.ended.rawValue),
                       AVAudioSessionInterruptionOptionKey: NSNumber(value: AVAudioSession.InterruptionOptions.shouldResume.rawValue)])
        try await eventually { self.model.isRecording }
        XCTAssertEqual(captures.count, 2)
    }

    func testInputDiscontinuityReconnectsWithoutWaitingForSystemEndNotification() async throws {
        try await begin()
        let id = model.listeningSessionID
        captures[0].blockStop()
        foreground = false
        captures[0].emit(.interrupted)
        try await eventually { self.captures[0].stopCalls == 1 }
        XCTAssertTrue(model.isListening)
        XCTAssertFalse(model.isRecording)
        XCTAssertEqual(captures.count, 1)
        captures[0].releaseStop()
        try await eventually { self.model.isRecording }
        XCTAssertEqual(captures.count, 2)
        XCTAssertEqual(model.listeningSessionID, id)
    }

    func testWatchdogReconnectsStalledInputWithoutStoppingSession() async throws {
        try await begin()
        captures[0].setReceiving(false)
        model.checkCaptureHealth()
        try await eventually { self.model.isRecording }
        XCTAssertEqual(captures.count, 2)
    }

    func testMeterClearsOnPauseAndIgnoresLatePacketsFromOldMicrophone() async throws {
        try await begin()
        captures[0].emit(.meter([UInt8](repeating: 220, count: 32)))
        try await eventually { self.model.meter.levels.last == 220 }
        model.audioInterrupted()
        XCTAssertEqual(model.meter.levels, [UInt8](repeating: 0, count: 32))
        captures[0].emit(.meter([255]))
        await Task.yield()
        XCTAssertEqual(model.meter.levels, [UInt8](repeating: 0, count: 32))
        model.audioInterruptionEnded(shouldResume: true)
        try await eventually { self.model.isRecording }
        captures[0].emit(.meter([255]))
        captures[1].emit(.meter([UInt8](repeating: 80, count: 32)))
        try await eventually { self.model.meter.levels.last == 80 }
        model.stop()
        XCTAssertEqual(model.meter.levels, [UInt8](repeating: 0, count: 32))
    }

    func testRouteAndWatchdogDoNotFightAnActiveSystemInterruption() async throws {
        try await begin()
        model.audioInterrupted()
        model.audioInputChanged()
        model.checkCaptureHealth()
        model.audioRouteChanged(reason: AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue)
        try await eventually { !self.model.isFinishing }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(captures.count, 1)
        XCTAssertFalse(model.isStarting)
        model.audioInterruptionEnded(shouldResume: true)
        try await eventually { self.model.isRecording }
        XCTAssertEqual(captures.count, 2)
    }

    func testMediaResetRecoversButPreservesSystemVeto() async throws {
        try await begin()
        model.audioServicesLost()
        model.audioInputChanged()
        model.audioRouteChanged(reason: AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue)
        try await eventually { !self.model.isFinishing }
        XCTAssertEqual(captures.count, 1)
        model.audioServicesReset()
        try await eventually { self.model.isRecording }
        model.audioInterrupted()
        model.audioInterruptionEnded(shouldResume: false)
        model.audioServicesLost(); model.audioServicesReset()
        try await eventually { !self.model.isFinishing }
        XCTAssertEqual(captures.count, 2)
        XCTAssertFalse(model.isRecording)
    }

    func testConnectivityChangesNeverPauseLocalRecording() async throws {
        try await begin()
        let id = model.listeningSessionID
        model.networkChanged(.wifi)
        model.networkChanged(.offline)
        model.networkChanged(.cellular)
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(model.isRecording)
        XCTAssertEqual(model.listeningSessionID, id)
        XCTAssertEqual(captures.count, 1)
    }

    func testRecoveryCanOutlastThreeFailuresAndStillHasAFiniteBudget() async throws {
        makeModel(retryDelays: [.milliseconds(10), .milliseconds(20), .milliseconds(30), .milliseconds(40)])
        try await begin()
        failuresRemaining = 4
        model.audioInputChanged()
        try await eventually { self.model.isRecording }
        XCTAssertEqual(captures.count, 6)
        failuresRemaining = 100
        model.audioInputChanged()
        try await eventually { self.captures.count == 11 && !self.model.isStarting && !self.model.isFinishing }
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(captures.count, 11, "Recovery must not loop forever")
        XCTAssertTrue(model.isListening)
        model.stop()
        model.audioInputChanged()
        model.audioRouteChanged(reason: AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue)
        XCTAssertFalse(model.isStarting)
    }

    func testInterruptionPreservesSessionAndAutomaticallyResumesInBackgroundAfterFinalizing() async throws {
        try await begin()
        let session = model.listeningSessionID
        let started = try XCTUnwrap(model.startedAt)
        captures[0].blockStop()
        foreground = false
        model.audioInterrupted()
        XCTAssertTrue(model.isListening)
        XCTAssertFalse(model.isRecording)
        XCTAssertNotNil(model.pauseReason)
        XCTAssertNotNil(model.pausedAt)
        model.audioInterruptionEnded(shouldResume: true)
        model.audioInterruptionEnded(shouldResume: true)
        try await eventually { self.captures[0].stopCalls == 1 }
        XCTAssertEqual(captures.count, 1, "Resumption must wait for accepted audio to be saved")
        XCTAssertEqual(captures[0].deactivation, false, "The OS already deactivated the interrupted session")
        try await Task.sleep(for: .milliseconds(50))
        captures[0].releaseStop()
        try await eventually { self.model.isRecording }
        XCTAssertEqual(captures.count, 2, "Duplicate notifications must not create multiple engines")
        XCTAssertEqual(model.listeningSessionID, session)
        XCTAssertNil(model.pauseReason)
        XCTAssertNil(model.pausedAt)
        XCTAssertGreaterThan(try XCTUnwrap(model.startedAt), started, "Recording timer must exclude interruption time")
        captures[0].emit(.failed("stale capture"))
        captures[0].emit(.speech(true))
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertTrue(model.isRecording)
        XCTAssertFalse(model.isSpeaking)
    }

    func testStopWhileFinalizingPreventsQueuedAndFutureResumption() async throws {
        try await begin()
        let id = try XCTUnwrap(model.listeningSessionID)
        captures[0].blockStop()
        model.audioInterrupted()
        model.audioInterruptionEnded(shouldResume: true)
        model.stopFromLiveActivity(sessionID: id.uuidString)
        captures[0].releaseStop()
        try await eventually { !self.model.isFinishing }
        model.audioInterruptionEnded(shouldResume: true)
        model.resumeOnForeground()
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertFalse(model.isListening)
        XCTAssertFalse(model.isRecording)
        XCTAssertFalse(model.isStarting)
        XCTAssertEqual(captures.count, 1)
    }

    func testSystemVetoRequiresManualResume() async throws {
        try await begin()
        model.audioInterrupted()
        model.audioInterruptionEnded(shouldResume: false)
        try await eventually { !self.model.isFinishing }
        model.resumeOnForeground()
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(captures.count, 1)
        XCTAssertTrue(model.isListening)
        XCTAssertFalse(model.isRecording)
        model.resume()
        try await eventually { self.model.isRecording }
        XCTAssertEqual(captures.count, 2)
    }

    func testForegroundRecoversMissingEndNotificationAndFailedResumeStaysPaused() async throws {
        try await begin()
        model.audioInterrupted()
        failNextStart = true
        model.resumeOnForeground()
        try await eventually { self.captures.count == 2 && !self.model.isStarting && !self.model.isFinishing }
        XCTAssertTrue(model.isListening)
        XCTAssertFalse(model.isRecording)
        XCTAssertNotNil(model.pauseReason)
        model.resumeOnForeground()
        try await eventually { self.model.isRecording }
        XCTAssertEqual(captures.count, 3)
    }

    func testTransientResumeFailureRetriesAutomaticallyAndStopCancelsBackoff() async throws {
        try await begin()
        model.audioInterrupted()
        failNextStart = true
        model.audioInterruptionEnded(shouldResume: true)
        try await eventually { self.captures.count == 2 && !self.model.isStarting }
        try await eventually { self.model.isRecording }
        XCTAssertEqual(captures.count, 3)
        model.audioInterrupted()
        failNextStart = true
        model.audioInterruptionEnded(shouldResume: true)
        try await eventually { self.captures.count == 4 && !self.model.isStarting }
        model.stop()
        try await Task.sleep(for: .milliseconds(1100))
        XCTAssertEqual(captures.count, 4)
        XCTAssertFalse(model.isListening)
    }

    func testSecondInterruptionDuringSlowResumeCannotBeRevivedByLateActivation() async throws {
        try await begin()
        model.audioInterrupted()
        blockNextStart = true
        model.audioInterruptionEnded(shouldResume: true)
        try await eventually { self.captures.count == 2 && self.captures[1].isStartWaiting }
        model.audioInterrupted()
        captures[1].releaseStart() // Model an OS activation that ignores task cancellation.
        try await eventually { !self.model.isFinishing }
        XCTAssertFalse(model.isRecording)
        XCTAssertFalse(model.isStarting)
        XCTAssertTrue(model.isListening)
        XCTAssertEqual(captures[1].stopCalls, 1)
        XCTAssertEqual(captures[1].deactivation, true, "Release an OS activation that completed after cancellation")
        model.audioInterruptionEnded(shouldResume: true)
        try await eventually { self.model.isRecording }
        XCTAssertEqual(captures.count, 3)
    }

    func testStopDuringSlowInitialActivationNeverShowsRecording() async throws {
        blockNextStart = true
        model.agreeAndStart()
        try await eventually { self.captures.count == 1 && self.captures[0].isStartWaiting }
        model.stop()
        captures[0].releaseStart()
        try await eventually { !self.model.isFinishing }
        XCTAssertFalse(model.isListening)
        XCTAssertFalse(model.isRecording)
        XCTAssertFalse(model.isStarting)
        XCTAssertEqual(captures[0].stopCalls, 1)
        XCTAssertEqual(captures[0].deactivation, true)
    }

    func testAccountSwitchAndRelaunchNeverResumeAnOldSession() async throws {
        try await begin()
        model.audioInterrupted()
        model.configure(scope: "other-user", client: client())
        model.audioInterruptionEnded(shouldResume: true)
        model.resumeOnForeground()
        try await eventually { !self.model.isFinishing }
        XCTAssertFalse(model.isListening)
        XCTAssertEqual(captures.count, 1)
        let reopened = ListeningModel(storageRoot: root, observeAudio: false, observeNetwork: false)
        reopened.configure(scope: "interruption-test", client: client())
        reopened.audioInterruptionEnded(shouldResume: true)
        reopened.resumeOnForeground()
        XCTAssertFalse(reopened.isListening)
        XCTAssertFalse(reopened.isStarting)
    }

    private func begin() async throws {
        model.agreeAndStart()
        try await eventually { self.model.isRecording }
    }
    private func client() -> InstantClient {
        InstantClient(baseURL: URL(string: "https://interruption.invalid")!, bearerToken: "test")
    }
    private func eventually(_ predicate: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<200 {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Timed out waiting for audio lifecycle", file: file, line: line)
    }
}

private final class ControlledCapture: ListeningCaptureSession, @unchecked Sendable {
    private let lock = NSLock()
    private var holdStart: Bool
    private let failStart: Bool
    private var holdStop = false
    private var starting: CheckedContinuation<Void, Never>?
    private var stopping: CheckedContinuation<Void, Never>?
    private var stops = 0
    private var deactivate: Bool?
    private var receiving = true
    private let update: @Sendable (ListeningCapture.Update) -> Void
    init(blockStart: Bool, failStart: Bool, update: @escaping @Sendable (ListeningCapture.Update) -> Void) {
        self.holdStart = blockStart; self.failStart = failStart; self.update = update
    }
    var isReceivingAudio: Bool { lock.withLock { receiving } }
    func setReceiving(_ value: Bool) { lock.withLock { receiving = value } }
    var isStartWaiting: Bool { lock.withLock { starting != nil } }
    var stopCalls: Int { lock.withLock { stops } }
    var deactivation: Bool? { lock.withLock { deactivate } }
    func start() async throws {
        await withCheckedContinuation { continuation in
            let wait = lock.withLock { if holdStart { starting = continuation; return true }; return false }
            if !wait { continuation.resume() }
        }
        if failStart { throw ListeningCaptureError.invalidRoute }
    }
    func stop(deactivateSession: Bool) async -> String? {
        await withCheckedContinuation { continuation in
            let wait = lock.withLock {
                stops += 1; deactivate = deactivateSession
                if holdStop { stopping = continuation; return true }; return false
            }
            if !wait { continuation.resume() }
        }
        return nil
    }
    func blockStop() { lock.withLock { holdStop = true } }
    func releaseStart() {
        let pending = lock.withLock { holdStart = false; let c = starting; starting = nil; return c }
        pending?.resume()
    }
    func releaseStop() {
        let pending = lock.withLock { holdStop = false; let c = stopping; stopping = nil; return c }
        pending?.resume()
    }
    func emit(_ event: ListeningCapture.Update) { update(event) }
}

@MainActor private final class ControlledEchoLocationReader: EchoLocationReading {
    var history = EchoLocationHistory()
    var status = "Location unavailable. Echo can still record."
    var requests: [Bool] = []
    var stops = 0
    func prepare() { history = EchoLocationHistory() }
    func start(requestPermission: Bool) { requests.append(requestPermission) }
    func stop() { stops += 1; history.pause() }
}
