import XCTest
import UIKit
import Vision
import PDFKit
import InstantClient
@testable import Instant

@MainActor final class TodayCaptureTests: XCTestCase {
    func testSourceDatesUseTheBriefTimeZoneAcrossMidnight() {
        let timestamp = "2026-09-27T17:00:00.000Z"
        XCTAssertTrue(TodayPresentation.timestamp(timestamp, timeZone: "Asia/Shanghai").contains("28"))
        XCTAssertTrue(TodayPresentation.timestamp(timestamp, timeZone: "UTC").contains("27"))
    }
    func testFullDayCaptureIncludesBothEditionsAndOffscreenContent() throws {
        let editions = TodayPreview.briefs.filter { $0.localDate == "2026-09-28" }
        XCTAssertEqual(editions.count, 2)
        let url = try TodayCaptureRenderer.export(date: "2026-09-28", briefs: editions)
        defer { try? FileManager.default.removeItem(at: url) }
        XCTAssertEqual(url.pathExtension, "png")
        let image = try XCTUnwrap(UIImage(contentsOfFile: url.path))
        let cgImage = try XCTUnwrap(image.cgImage)
        XCTAssertGreaterThan(cgImage.height, 4000, "The export must include cards below the viewport, across both editions")
        let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate
        try VNImageRequestHandler(cgImage: cgImage).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        XCTAssertTrue(text.contains("Morning Brief"), text)
        XCTAssertTrue(text.contains("Evening Brief"), text)
        XCTAssertTrue(text.contains("throughout your day"), "The last footer must be captured too")
        let attachment = XCTAttachment(contentsOfFile: url); attachment.name = "Full-day Today capture"; attachment.lifetime = .keepAlways; add(attachment)
    }
    func testNoCaptureForEmptyOrUnfinishedDay() {
        XCTAssertThrowsError(try TodayCaptureRenderer.export(date: "2026-09-28", briefs: []))
    }
    func testVeryLongDayExportsCompletePDFInsteadOfClipping() throws {
        let base = try JSONSerialization.jsonObject(with: JSONEncoder().encode(TodayPreview.briefs[0])) as! [String: Any]
        let rows = try (0..<20).map { index -> TodayBrief in
            var value = base; value["id"] = "long-\(index)"
            var content = value["content"] as! [String: Any]
            content["title"] = "Complete edition \(index + 1)"
            value["content"] = content
            return try JSONDecoder().decode(TodayBrief.self, from: JSONSerialization.data(withJSONObject: value))
        }
        let url = try TodayCaptureRenderer.export(date: "2026-09-28", briefs: rows)
        defer { try? FileManager.default.removeItem(at: url) }
        XCTAssertEqual(url.pathExtension, "pdf")
        let document = try XCTUnwrap(CGPDFDocument(url as CFURL))
        XCTAssertGreaterThan(document.numberOfPages, 16)
        let pdf = try XCTUnwrap(PDFDocument(url: url))
        let text = try XCTUnwrap(pdf.string)
        for index in 1...20 { XCTAssertTrue(text.contains("Complete edition \(index)"), "Edition \(index) must appear in the PDF") }
        XCTAssertTrue(text.contains("throughout your day"), "The final footer must also survive PDF pagination")
        // Text extraction includes off-page glyphs. Rasterize the actual first/last pages
        // to catch reversed pagination or upside-down drawing in UIKit's PDF context.
        for (index, expected) in [(0, "Complete edition 1"), (pdf.pageCount - 1, "throughout your day")] {
            let pageImage = try XCTUnwrap(pdf.page(at: index)?.thumbnail(of: CGSize(width: 860, height: 2000), for: .mediaBox))
            let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate
            try VNImageRequestHandler(cgImage: XCTUnwrap(pageImage.cgImage)).perform([request])
            let visible = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
            XCTAssertTrue(visible.contains(expected), "Page \(index + 1) must be upright and in order: \(visible)")
            let pageAttachment = XCTAttachment(image: pageImage); pageAttachment.name = "PDF page \(index + 1)"; pageAttachment.lifetime = .keepAlways; add(pageAttachment)
        }
        let attachment = XCTAttachment(contentsOfFile: url); attachment.name = "Complete long-day PDF"; attachment.lifetime = .keepAlways; add(attachment)
    }
}
