import ClerkKit
import XCTest
@testable import Instant

/// Opt-in network coverage using a disposable Clerk development account only.
@MainActor
final class PasswordSignInLiveTests: XCTestCase {
    func testResetPasswordAndSignInWithNewPassword() async throws {
        let path = URL(fileURLWithPath: "/tmp/impo-password-auth-test.json")
        guard FileManager.default.fileExists(atPath: path.path) else { throw XCTSkip("Requires disposable Clerk development credentials") }
        let data = try Data(contentsOf: path)
        var credentials = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        let email = try XCTUnwrap(credentials["email"])
        let userID = try XCTUnwrap(credentials["userId"])
        guard ClerkConfig.publishableKey.hasPrefix("pk_test_"), email.contains("+clerk_test@") else {
            throw XCTSkip("Live password tests are limited to Clerk development test users")
        }
        for _ in 0..<200 {
            if Clerk.shared.isLoaded { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertTrue(Clerk.shared.isLoaded)
        // Never sign out an unrelated account on this Simulator.
        if let user = Clerk.shared.user {
            guard user.id == userID else { throw XCTSkip("Simulator has an unrelated signed-in account") }
            try await Clerk.shared.auth.signOut()
        }
        let flow = PasswordSignInFlow(onComplete: {})
        flow.showReset()
        await flow.sendReset(email: email)
        XCTAssertNil(flow.error)
        XCTAssertEqual(flow.step, .code)
        await flow.verify(code: "424242")
        XCTAssertNil(flow.error)
        XCTAssertEqual(flow.step, .newPassword)
        let password = UUID().uuidString + "aA1!"
        await flow.reset(password: password)
        XCTAssertNil(flow.error)
        XCTAssertEqual(flow.step, .complete)
        XCTAssertEqual(Clerk.shared.user?.id, userID)
        credentials["password"] = password
        try JSONSerialization.data(withJSONObject: credentials).write(to: path, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        try await Clerk.shared.auth.signOut()
        let second = PasswordSignInFlow(onComplete: {})
        await second.signIn(email: email, password: password)
        if second.step == .code { await second.verify(code: "424242") }
        XCTAssertNil(second.error)
        XCTAssertEqual(second.step, .complete)
        XCTAssertEqual(Clerk.shared.user?.id, userID)
        if Clerk.shared.user?.id == userID { try await Clerk.shared.auth.signOut() }
    }
}
