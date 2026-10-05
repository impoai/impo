import ClerkKit
import XCTest
@testable import Instant

@MainActor
final class PasswordSignInTests: XCTestCase {
    private let email = Factor(strategy: .emailCode, emailAddressId: "email_1", safeIdentifier: "t***@example.com")

    func testPasswordSuccessActivatesBeforeRestoringAccount() async {
        let service = FakePasswordService()
        service.result = SignIn(id: "attempt", status: .complete, createdSessionId: "session_A")
        var restored = false
        let flow = PasswordSignInFlow(service: service) {
            XCTAssertEqual(service.activated, ["session_A"])
            restored = true
        }
        await flow.signIn(email: " user@example.com \n", password: " a password ")
        XCTAssertEqual(service.identifier, "user@example.com")
        XCTAssertEqual(service.password, " a password ")
        XCTAssertTrue(restored)
        XCTAssertEqual(flow.step, .complete)
    }

    func testDeviceTrustAndIncorrectCodeDoNotActivateSession() async {
        let service = FakePasswordService()
        service.result = SignIn(id: "attempt", status: .needsClientTrust, supportedSecondFactors: [email])
        let flow = PasswordSignInFlow(service: service) { XCTFail("Cannot restore an incomplete session") }
        await flow.signIn(email: "user@example.com", password: "password")
        XCTAssertEqual(flow.step, .code)
        XCTAssertTrue(service.sentSecondFactor)
        XCTAssertTrue(flow.codeSent)
        service.failure = PasswordSignInError("Incorrect code")
        await flow.verify(code: "000000")
        XCTAssertEqual(flow.error, "Incorrect code")
        XCTAssertEqual(flow.step, .code)
        XCTAssertTrue(service.activated.isEmpty)
    }

    func testDeviceTrustCompletesOnlyAfterVerification() async {
        let service = FakePasswordService()
        service.result = SignIn(id: "attempt", status: .needsSecondFactor, supportedSecondFactors: [email])
        let flow = PasswordSignInFlow(service: service) {}
        await flow.signIn(email: "user@example.com", password: "password")
        XCTAssertTrue(service.activated.isEmpty)
        service.result = SignIn(id: "attempt", status: .complete, createdSessionId: "session_A")
        await flow.verify(code: "123456")
        XCTAssertTrue(service.verifiedSecondFactor)
        XCTAssertEqual(service.activated, ["session_A"])
        XCTAssertEqual(flow.step, .complete)
    }

    func testResetRequiresCodeThenNewPasswordAndAllowsRetry() async {
        let service = FakePasswordService()
        let reset = Factor(strategy: .resetPasswordEmailCode, emailAddressId: "email_1")
        service.result = SignIn(id: "attempt", status: .needsFirstFactor, supportedFirstFactors: [reset])
        let flow = PasswordSignInFlow(service: service) {}
        flow.showReset()
        await flow.sendReset(email: "user@example.com")
        XCTAssertEqual(flow.step, .code)
        XCTAssertFalse(service.sentSecondFactor)
        service.result = SignIn(id: "attempt", status: .needsNewPassword)
        await flow.verify(code: "123456")
        XCTAssertEqual(flow.step, .newPassword)
        XCTAssertTrue(service.activated.isEmpty)
        service.failure = PasswordSignInError("Password is too short")
        await flow.reset(password: "x")
        XCTAssertEqual(flow.step, .newPassword)
        XCTAssertEqual(flow.error, "Password is too short")
        service.failure = nil
        service.result = SignIn(id: "attempt", status: .complete, createdSessionId: "session_A")
        await flow.reset(password: "a stronger password")
        XCTAssertEqual(flow.step, .complete)
    }

    func testFailedCodeDeliveryCanBeRetriedWithoutVerifyingUnsentCode() async {
        let service = FakePasswordService()
        service.result = SignIn(id: "attempt", status: .needsClientTrust, supportedSecondFactors: [email])
        service.sendFailure = PasswordSignInError("Try sending again")
        let flow = PasswordSignInFlow(service: service) {}
        await flow.signIn(email: "user@example.com", password: "password")
        XCTAssertEqual(flow.step, .code)
        XCTAssertFalse(flow.codeSent)
        await flow.verify(code: "123456")
        XCTAssertEqual(service.verifyCalls, 0)
        service.sendFailure = nil
        await flow.resend()
        XCTAssertTrue(flow.codeSent)
        XCTAssertNil(flow.error)
    }

    func testMfaBackupCodeIsAvailableWithoutSendingMessage() async {
        let service = FakePasswordService()
        let backup = Factor(strategy: .backupCode)
        service.result = SignIn(id: "attempt", status: .needsSecondFactor, supportedSecondFactors: [backup, Factor(strategy: .totp)])
        let flow = PasswordSignInFlow(service: service) {}
        await flow.signIn(email: "user@example.com", password: "password")
        XCTAssertEqual(flow.factor?.strategy, .totp)
        XCTAssertFalse(flow.canResend)
        await flow.selectFactor(backup)
        XCTAssertEqual(flow.factor?.strategy, .backupCode)
        XCTAssertFalse(flow.canResend)
    }

    func testMissingSessionAndActivationFailureNeverRestoreAccount() async {
        let service = FakePasswordService()
        service.result = SignIn(id: "attempt", status: .complete)
        let flow = PasswordSignInFlow(service: service) { XCTFail("Invalid session must not restore account") }
        await flow.signIn(email: "user@example.com", password: "password")
        XCTAssertNotNil(flow.error)
        XCTAssertNotEqual(flow.step, .complete)
        service.result = SignIn(id: "attempt", status: .complete, createdSessionId: "session_A")
        service.activationFailure = PasswordSignInError("Session expired")
        await flow.signIn(email: "user@example.com", password: "password")
        XCTAssertEqual(flow.error, "Session expired")
        XCTAssertNotEqual(flow.step, .complete)
    }

    func testIncorrectPasswordAndUnsupportedFactorsKeepAccountSignedOut() async {
        let service = FakePasswordService()
        let flow = PasswordSignInFlow(service: service) { XCTFail("Cannot restore account") }
        service.failure = PasswordSignInError("Incorrect password")
        await flow.signIn(email: "user@example.com", password: "wrong")
        XCTAssertEqual(flow.error, "Incorrect password")
        XCTAssertEqual(flow.step, .credentials)
        service.failure = nil
        service.result = SignIn(id: "attempt", status: .needsClientTrust, supportedSecondFactors: [Factor(strategy: .passkey)])
        await flow.signIn(email: "user@example.com", password: "password")
        XCTAssertNotNil(flow.error)
        XCTAssertTrue(service.activated.isEmpty)
        flow.startOver()
        XCTAssertNil(flow.factor)
        XCTAssertNil(flow.error)
    }
}

@MainActor
private final class FakePasswordService: PasswordSignInService {
    var result = SignIn(id: "attempt", status: .needsFirstFactor)
    var failure: Error?
    var sendFailure: Error?
    var activationFailure: Error?
    var identifier: String?
    var password: String?
    var sentSecondFactor = false
    var verifiedSecondFactor = false
    var verifyCalls = 0
    var activated: [String] = []
    func start(email: String, password: String?) async throws -> SignIn {
        identifier = email; self.password = password
        if let failure { throw failure }
        return result
    }
    func sendCode(_ signIn: SignIn, factor: Factor, secondFactor: Bool) async throws -> SignIn {
        sentSecondFactor = secondFactor
        if let sendFailure { throw sendFailure }
        return signIn
    }
    func verify(_ signIn: SignIn, code: String, factor: Factor, secondFactor: Bool) async throws -> SignIn {
        verifyCalls += 1; verifiedSecondFactor = secondFactor
        if let failure { throw failure }
        return result
    }
    func resetPassword(_ signIn: SignIn, password: String) async throws -> SignIn {
        if let failure { throw failure }
        return result
    }
    func activate(sessionID: String) async throws {
        if let activationFailure { throw activationFailure }
        activated.append(sessionID)
    }
}
