import XCTest
import MathJaxSwift
@testable import LaTeXSwiftUI
@testable import Instant

final class ResponseDocumentTests: XCTestCase {
    func testLogarithmicDifferentiationPreservesBackslashDelimitersAndCommands() {
        let source = #"""
        ## 对数求导

        比如 \(y=x^x\)，先取对数：

        \[
        \ln y=x\ln x
        \]

        两边求导：

        \[
        \frac{y'}{y}=\ln x+1
        \]

        所以 **结果** 是 $y'=x^x(\ln x+1)$。
        """#
        let result = ResponseDocument(source)
        XCTAssertEqual(result.blocks.count, 6)
        guard case .heading(2, let heading) = result.blocks[0] else { return XCTFail("Expected heading") }
        XCTAssertEqual(heading.plain, "对数求导")
        guard case .paragraph(let inline) = result.blocks[1], case .math(let formula) = result.blocks[2] else { return XCTFail("Expected inline and display equations") }
        XCTAssertTrue(inline.latex?.contains(#"\(y=x^x\)"#) == true)
        XCTAssertTrue(formula.contains(#"\ln y=x\ln x"#))
        XCTAssertTrue(result.plainText.contains(#"\frac{y'}{y}"#))
        XCTAssertFalse(result.plainText.contains("IMPOMATHTOKEN"))
        XCTAssertFalse(result.plainText.contains("**"))
    }

    func testGFMTableAndNestedListProduceReadableSelectableText() {
        let result = ResponseDocument(#"""
        | Item | Amount | Formula |
        | :--- | ---: | :---: |
        | **Tea** | 12 | $x^2$ |
        | A\|B | 8 | `a+b` |

        3. First
           - Nested item
        4. Next

        > A quoted **idea**.
        """#)
        guard case .table(let header, let columns, let rows) = result.blocks[0] else { return XCTFail("Expected table") }
        XCTAssertEqual(header.map(\.plain), ["Item", "Amount", "Formula"])
        XCTAssertEqual(columns, [.leading, .trailing, .center])
        XCTAssertEqual(rows[1][0].plain, "A|B")
        XCTAssertNotNil(rows[0][2].latex)
        XCTAssertTrue(result.plainText.contains("Tea\t12\t$x^2$"))
        guard case .list(let entries) = result.blocks[1] else { return XCTFail("Expected list") }
        XCTAssertEqual(entries.map(\.marker), ["3.", "4."])
        guard case .list = entries[0].blocks[1] else { return XCTFail("Nested list lost") }
        XCTAssertTrue(result.plainText.contains("A quoted idea."))
        guard case .quote(let quote) = result.blocks[2], case .paragraph(let value) = quote[0] else { return XCTFail("Expected quote") }
        XCTAssertFalse(value.markdown.hasPrefix(">"))
        XCTAssertEqual(ResponseDocument("How's your day?").plainText, "How's your day?")
    }

    func testCurrencyEscapesAndCodeNeverBecomeMath() {
        let source = #"""
        Pay $5 and $10. Escaped \$x\$ stays literal. Use `$y$` in code.

        ```latex
        \[x^2\]
        $ignored$
        ```

        ~~~~text
        ```
        $also_ignored$
        ~~~~
        """#
        let result = ResponseDocument(source)
        guard case .paragraph(let inline) = result.blocks[0] else { return XCTFail("Expected prose") }
        XCTAssertNil(inline.latex)
        XCTAssertTrue(inline.plain.contains("Pay $5 and $10"))
        guard case .code("latex", let code) = result.blocks[1] else { return XCTFail("Expected code") }
        XCTAssertEqual(code, "\\[x^2\\]\n$ignored$")
        XCTAssertTrue(result.plainText.contains("```\n$also_ignored$"))
    }

    func testStreamingIncompleteMarkupAndMathRecoverWithoutLosingSource() {
        let partial = ResponseDocument("```swift\nlet x = 1\n")
        XCTAssertEqual(partial.blocks, [.code("swift", "let x = 1")])
        let prefix = #"Before \[\frac{1}{2}"#
        XCTAssertTrue(ResponseDocument(prefix).plainText.contains(#"\[\frac{1}{2}"#))
        let complete = ResponseDocument(prefix + #"\] after"#)
        XCTAssertEqual(complete.blocks.count, 3)
        guard case .math = complete.blocks[1] else { return XCTFail("Display equation must stand alone") }
        XCTAssertTrue(complete.plainText.contains(#"\[\frac{1}{2}\]"#))
        XCTAssertTrue(complete.plainText.hasSuffix("after"))
        XCTAssertEqual(ResponseDocument("| A | B |\n| ---").blocks.count, 1)
    }

    func testCompoundExponentInTableReachesOfflineMathRenderer() throws {
        let document = ResponseDocument("| F | D |\n| --- | --- |\n| x | $nx^{n-1}$ |")
        guard case .table(_, _, let rows) = document.blocks[0] else { return XCTFail("Expected table") }
        XCTAssertEqual(rows[0][1].latex, "$nx^{n-1}$")
        let renderer = try MathJax(preferredOutputFormats: [.svg])
        let options = TeXInputProcessorOptions(processEscapes: true, errorMode: .original)
        for formula in ["nx^{n-1}", "x^{2}", "x^{-1}", "x^{n+1}", #"\frac{1}{2}"#, #"\sqrt{x+1}"#] {
            var error: Error?
            let svg = renderer.tex2svg(formula, styles: false, inputOptions: options, error: &error)
            XCTAssertNil(error, formula)
            XCTAssertTrue(svg.contains("<svg"))
        }
    }

    func testLongChineseResponseKeepsTheWholeSelectionSnapshot() {
        let source = (1...300).map { "## Section \($0)\n\n中文段落 \($0)，**important** details.\n\n\\[x_{\($0)}^2\\]" }.joined(separator: "\n\n")
        let document = ResponseDocument(source)
        XCTAssertEqual(document.blocks.count, 900)
        XCTAssertTrue(document.plainText.hasPrefix("Section 1"))
        XCTAssertTrue(document.plainText.contains("中文段落 300，important details."))
        XCTAssertTrue(document.plainText.hasSuffix(#"\[x_{300}^2\]"#))
    }
}
