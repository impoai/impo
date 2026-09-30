import XCTest
@testable import Instant

@MainActor
final class PublicConfigurationTests: XCTestCase {
    func testUnconfiguredCheckoutCanStartAndRejectsLiveSignInWithoutSDKAccess() async throws {
        guard !ClerkConfig.isConfigured else {
            throw XCTSkip("Run without Config.local.xcconfig to verify the public checkout.")
        }
        let model = AppModel()
        await model.syncRealAuthFromClerkSession()
        XCTAssertFalse(model.usesRealAuth)
        do {
            try await model.signIn(with: .google)
            XCTFail("Live sign-in must require local configuration.")
        } catch {
            XCTAssertEqual((error as NSError).domain, "ImpoConfiguration")
        }
    }
}
