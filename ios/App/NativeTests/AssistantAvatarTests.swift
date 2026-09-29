import XCTest
import UIKit
@testable import Instant

@MainActor final class AssistantAvatarTests: XCTestCase {
    func testShippedAvatarChoicesDecodeToSixDifferentImages() throws {
        XCTAssertEqual(AssistantLook.choices.count, 6)
        XCTAssertEqual(AssistantLook.choices.filter { $0.asset == "InstantMark" }.count, 1)
        var rendered = Set<Data>()
        for look in AssistantLook.choices {
            let image = try XCTUnwrap(UIImage(named: look.asset), "Missing compiled asset: \(look.asset)")
            XCTAssertGreaterThanOrEqual(image.size.width * image.scale, 474, "Large preview needs a sharp 3x asset")
            rendered.insert(try XCTUnwrap(image.pngData()))
        }
        XCTAssertEqual(rendered.count, 6, "Different asset names must not hide repeated placeholder artwork")
    }
}
