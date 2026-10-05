import ClerkKit
import Foundation
import Observation

@MainActor
protocol PasswordSignInService {
    func start(email: String, password: String?) async throws -> SignIn
    func sendCode(_ signIn: SignIn, factor: Factor, secondFactor: Bool) async throws -> SignIn
    func verify(_ signIn: SignIn, code: String, factor: Factor, secondFactor: Bool) async throws -> SignIn
    func resetPassword(_ signIn: SignIn, password: String) async throws -> SignIn
    func activate(sessionID: String) async throws
}

@MainActor
struct ClerkPasswordSignInService: PasswordSignInService {
    func start(email: String, password: String?) async throws -> SignIn {
        guard ClerkConfig.isConfigured else { throw PasswordSignInError("Sign-in is unavailable in this build.") }
        if let password { return try await Clerk.shared.auth.signInWithPassword(identifier: email, password: password) }
        return try await Clerk.shared.auth.signIn(email)
    }

    func sendCode(_ signIn: SignIn, factor: Factor, secondFactor: Bool) async throws -> SignIn {
        switch factor.strategy {
        case .resetPasswordEmailCode: try await signIn.sendResetPasswordEmailCode(emailAddressId: factor.emailAddressId)
        case .emailCode:
            if secondFactor { try await signIn.sendMfaEmailCode(emailAddressId: factor.emailAddressId) }
            else { try await signIn.sendEmailCode(emailAddressId: factor.emailAddressId) }
        case .phoneCode:
            if secondFactor { try await signIn.sendMfaPhoneCode(phoneNumberId: factor.phoneNumberId) }
            else { try await signIn.sendPhoneCode(phoneNumberId: factor.phoneNumberId) }
        case .totp, .backupCode: signIn
        default: throw PasswordSignInError("Use Apple or Google to sign in to this account.")
        }
    }

    func verify(_ signIn: SignIn, code: String, factor: Factor, secondFactor: Bool) async throws -> SignIn {
        guard secondFactor else { return try await signIn.verifyCode(code) }
        let type: SignIn.MfaType
        switch factor.strategy {
        case .emailCode: type = .emailCode
        case .phoneCode: type = .phoneCode
        case .totp: type = .totp
        case .backupCode: type = .backupCode
        default: throw PasswordSignInError("Choose another verification method.")
        }
        return try await signIn.verifyMfaCode(code, type: type)
    }

    func resetPassword(_ signIn: SignIn, password: String) async throws -> SignIn {
        try await signIn.resetPassword(newPassword: password, signOutOfOtherSessions: true)
    }

    func activate(sessionID: String) async throws {
        try await Clerk.shared.auth.setActive(sessionId: sessionID)
        guard Clerk.shared.session?.id == sessionID, Clerk.shared.user != nil else { throw ClerkTokenError.notSignedIn }
    }
}

struct PasswordSignInError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// Only Clerk's completed, activated session may enter the account restoration flow.
@MainActor @Observable
final class PasswordSignInFlow {
    enum Step { case credentials, resetEmail, code, newPassword, complete }
    private(set) var step: Step = .credentials
    private(set) var busy = false
    private(set) var error: String?
    private(set) var factor: Factor?
    private(set) var factors: [Factor] = []
    private(set) var codeSent = false
    private var signIn: SignIn?
    private var secondFactor = false
    private let service: any PasswordSignInService
    private let onComplete: @MainActor () async throws -> Void

    init(service: any PasswordSignInService = ClerkPasswordSignInService(), onComplete: @escaping @MainActor () async throws -> Void) {
        self.service = service
        self.onComplete = onComplete
    }

    var codeHelp: String {
        switch factor?.strategy {
        case .totp: "Enter the code from your authenticator app."
        case .backupCode: "Enter one of your unused backup codes."
        case .phoneCode: "Enter the code sent to \(factor?.safeIdentifier ?? "your phone")."
        default: "Enter the code sent to \(factor?.safeIdentifier ?? "your email")."
        }
    }
    var canResend: Bool { factor?.strategy != .totp && factor?.strategy != .backupCode }

    func showReset() { guard !busy else { return }; clear(); step = .resetEmail }
    func startOver() { guard !busy else { return }; clear(); step = .credentials }
    private func clear() { signIn = nil; factor = nil; factors = []; error = nil; codeSent = false }

    func signIn(email: String, password: String) async {
        await perform {
            let email = email.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !email.isEmpty, !password.isEmpty else { throw PasswordSignInError("Enter your email and password.") }
            let attempt = try await self.service.start(email: email, password: password)
            try await self.advance(attempt)
        }
    }

    func sendReset(email: String) async {
        await perform {
            let email = email.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !email.isEmpty else { throw PasswordSignInError("Enter your account email.") }
            let attempt = try await self.service.start(email: email, password: nil)
            self.signIn = attempt
            guard let reset = attempt.supportedFirstFactors?.first(where: { $0.strategy == .resetPasswordEmailCode }) else {
                throw PasswordSignInError("This account has no password to reset. Continue with Apple or Google.")
            }
            self.secondFactor = false
            self.factors = [reset]
            try await self.prepare(reset)
        }
    }

    func selectFactor(_ factor: Factor) async { await perform { try await self.prepare(factor) } }

    func resend() async {
        guard let factor, canResend else { return }
        await perform { try await self.prepare(factor) }
    }

    func verify(code: String) async {
        await perform {
            guard let attempt = self.signIn, let factor = self.factor, self.codeSent else {
                throw PasswordSignInError("Send a verification code first.")
            }
            let code = code.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !code.isEmpty else { throw PasswordSignInError("Enter your verification code.") }
            let verified = try await self.service.verify(attempt, code: code, factor: factor, secondFactor: self.secondFactor)
            try await self.advance(verified)
        }
    }

    func reset(password: String) async {
        await perform {
            guard let attempt = self.signIn, self.step == .newPassword else { return }
            guard !password.isEmpty else { throw PasswordSignInError("Enter a new password.") }
            let updated = try await self.service.resetPassword(attempt, password: password)
            try await self.advance(updated)
        }
    }

    private func perform(_ operation: () async throws -> Void) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do { try await operation() }
        catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }

    private func prepare(_ factor: Factor) async throws {
        guard let attempt = signIn else { return }
        self.factor = factor; step = .code; codeSent = false
        signIn = try await service.sendCode(attempt, factor: factor, secondFactor: secondFactor)
        codeSent = true
    }

    private func advance(_ attempt: SignIn) async throws {
        try Task.checkCancellation()
        signIn = attempt
        switch attempt.status {
        case .complete:
            guard let sessionID = attempt.createdSessionId else { throw PasswordSignInError("Sign-in did not create a session. Please try again.") }
            try await service.activate(sessionID: sessionID)
            try await onComplete()
            step = .complete
        case .needsNewPassword: step = .newPassword
        case .needsSecondFactor, .needsClientTrust, .needsFirstFactor:
            secondFactor = attempt.status != .needsFirstFactor
            let available = (secondFactor ? attempt.supportedSecondFactors : attempt.supportedFirstFactors) ?? []
            let strategies: [FactorStrategy] = secondFactor ? [.totp, .emailCode, .phoneCode, .backupCode] : [.emailCode, .phoneCode]
            factors = strategies.flatMap { strategy in available.filter { $0.strategy == strategy } }
            guard let first = factors.first else { throw PasswordSignInError("Use Apple or Google to sign in to this account.") }
            try await prepare(first)
        default: throw PasswordSignInError("Sign-in could not finish. Please try again or continue with Apple or Google.")
        }
    }
}

extension Factor {
    var passwordFlowLabel: String {
        switch strategy {
        case .totp: "Authenticator app"
        case .backupCode: "Backup code"
        case .phoneCode: "Text message"
        default: "Email code"
        }
    }
}
