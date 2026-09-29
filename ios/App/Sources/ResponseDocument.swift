import Foundation
import Markdown

/// One parsed snapshot supplies both the visual response and cross-paragraph selection.
/// Protect TeX before CommonMark consumes backslashes such as \( and \[.
struct ResponseDocument: Equatable {
    struct Inline: Equatable {
        let markdown: String
        let plain: String
        let latex: String?
    }
    struct ListEntry: Equatable {
        let marker: String
        let blocks: [Block]
    }
    enum Column: Equatable { case leading, center, trailing }
    indirect enum Block: Equatable {
        case paragraph(Inline), heading(Int, Inline), code(String, String), math(String)
        case quote([Block]), list([ListEntry]), table([Inline], [Column], [[Inline]]), divider
    }
    let blocks: [Block]
    let plainText: String

    init(_ source: String) {
        let math = ResponseMath(source)
        let document = Document(parsing: math.protected, options: [.disableSmartOpts])
        func plain(_ node: any Markup) -> String {
            if let text = node as? Markdown.Text { return math.restore(text.string) }
            if let code = node as? InlineCode { return math.restore(code.code) }
            if node is SoftBreak { return " " }
            if node is LineBreak { return "\n" }
            if let html = node as? InlineHTML { return math.restore(html.rawHTML) }
            return node.children.map(plain).joined()
        }
        func inline(_ node: any Markup) -> Inline {
            let formatted = node.children.map { $0.detachedFromParent.format() }.joined().trimmingCharacters(in: .whitespacesAndNewlines)
            return Inline(markdown: math.hasIncomplete(formatted) ? "" : math.restore(formatted), plain: plain(node), latex: math.hasIncomplete(formatted) ? nil : math.latex(formatted))
        }
        func convert(_ node: any Markup) -> [Block] {
            if let code = node as? CodeBlock { return [.code(code.language ?? "", math.restore(code.code).trimmingTrailingNewline)] }
            if let heading = node as? Heading { return [.heading(heading.level, Inline(markdown: math.restore(heading.children.map { $0.detachedFromParent.format() }.joined()), plain: plain(heading), latex: math.latex(heading.children.map { $0.detachedFromParent.format() }.joined())))] }
            if let paragraph = node as? Paragraph {
                let formatted = paragraph.detachedFromParent.format().trimmingCharacters(in: .whitespacesAndNewlines)
                var remaining = formatted, result: [Block] = []
                while let next = math.equations.compactMap({ key, equation -> (Range<String.Index>, String)? in
                    guard equation.display, equation.complete, let range = remaining.range(of: key) else { return nil }
                    return (range, equation.source)
                }).min(by: { $0.0.lowerBound < $1.0.lowerBound }) {
                    let prefix = String(remaining[..<next.0.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
                    if !prefix.isEmpty {
                        let parsed = Document(parsing: prefix, options: [.disableSmartOpts])
                        result.append(.paragraph(Inline(markdown: math.restore(prefix), plain: parsed.children.map(plain).joined(), latex: math.latex(prefix))))
                    }
                    result.append(.math(next.1))
                    remaining = String(remaining[next.0.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
                }
                if result.isEmpty { return [.paragraph(inline(paragraph))] }
                if !remaining.isEmpty {
                    let parsed = Document(parsing: remaining, options: [.disableSmartOpts])
                    result.append(.paragraph(Inline(markdown: math.restore(remaining), plain: parsed.children.map(plain).joined(), latex: math.latex(remaining))))
                }
                return result
            }
            if let quote = node as? BlockQuote { return [.quote(quote.children.flatMap(convert))] }
            if node is OrderedList || node is UnorderedList {
                let start = (node as? OrderedList)?.startIndex
                let entries = node.children.enumerated().map { index, item in
                    let marker: String
                    if let checkbox = (item as? ListItem)?.checkbox { marker = checkbox == .checked ? "☑" : "☐" }
                    else { marker = start.map { "\($0 + UInt(index))." } ?? "•" }
                    return ListEntry(marker: marker, blocks: item.children.flatMap(convert))
                }
                return [.list(entries)]
            }
            if let table = node as? Markdown.Table {
                let columns: [Column] = table.columnAlignments.map {
                    switch $0 { case .center: .center; case .right: .trailing; default: .leading }
                }
                return [.table(table.head.cells.map(inline), columns, table.body.rows.map { $0.cells.map(inline) })]
            }
            if node is ThematicBreak { return [.divider] }
            if let html = node as? HTMLBlock { return [.paragraph(Inline(markdown: "", plain: math.restore(html.rawHTML), latex: nil))] }
            return node.children.flatMap(convert)
        }
        blocks = document.children.flatMap(convert)
        plainText = Self.text(blocks)
    }

    static func text(_ blocks: [Block]) -> String {
        blocks.map { block in
            switch block {
            case .paragraph(let inline), .heading(_, let inline): inline.plain
            case .code(_, let text), .math(let text): text
            case .quote(let children): text(children)
            case .list(let entries): entries.map { "\($0.marker) \(text($0.blocks))" }.joined(separator: "\n")
            case .table(let head, _, let rows): ([head] + rows).map { $0.map(\.plain).joined(separator: "\t") }.joined(separator: "\n")
            case .divider: "—"
            }
        }.joined(separator: "\n\n")
    }
}

private extension String {
    var trimmingTrailingNewline: String { hasSuffix("\n") ? String(dropLast()) : self }
}

/// Math is recognized outside code. Currency, escaped delimiters and incomplete
/// streamed equations remain literal; a later snapshot can finish the equation.
struct ResponseMath {
    struct Equation { let source: String; let display: Bool; let complete: Bool }
    let protected: String
    let equations: [String: Equation]

    init(_ source: String) {
        let chars = Array(source)
        var output = "", equations: [String: Equation] = [:], i = 0
        var prefix = "IMPOMATHTOKEN"
        while source.contains(prefix) { prefix += "X" }
        var fence: (Character, Int)?
        func matches(_ value: String, _ offset: Int) -> Bool {
            let value = Array(value)
            return offset + value.count <= chars.count && chars[offset..<(offset + value.count)].elementsEqual(value)
        }
        func escaped(_ offset: Int) -> Bool {
            var cursor = offset, count = 0
            while cursor > 0 && chars[cursor - 1] == "\\" { count += 1; cursor -= 1 }
            return !count.isMultiple(of: 2)
        }
        while i < chars.count {
            // Preserve complete fence lines and their bodies, including incomplete fences.
            if i == 0 || chars[i - 1] == "\n" {
                let end = chars[i...].firstIndex(of: "\n") ?? chars.count
                let line = Array(chars[i..<end])
                let spaces = line.prefix(while: { $0 == " " }).count
                let trimmed = Array(line.dropFirst(spaces))
                let run = trimmed.first.map { first in trimmed.prefix(while: { $0 == first }).count } ?? 0
                if spaces <= 3, let first = trimmed.first, [Character("`"), Character("~")].contains(first), run >= 3 {
                    if let active = fence {
                        if first == active.0 && run >= active.1 && trimmed.dropFirst(run).allSatisfy(\.isWhitespace) { fence = nil }
                    } else { fence = (first, run) }
                    output += String(line); i = end
                    if i < chars.count { output.append(chars[i]); i += 1 }; continue
                }
                if fence != nil || spaces >= 4 {
                    output += String(line); i = end
                    if i < chars.count { output.append(chars[i]); i += 1 }; continue
                }
            }
            if chars[i] == "`", !escaped(i) {
                let count = chars[i...].prefix(while: { $0 == "`" }).count
                var end = i + count
                while end < chars.count {
                    if chars[end] == "`" {
                        let close = chars[end...].prefix(while: { $0 == "`" }).count
                        if close == count { end += count; break }
                        end += close
                    } else { end += 1 }
                }
                output += String(chars[i..<end]); i = end; continue
            }
            let delimiters: [(String, String, Bool)] = [("\\[", "\\]", true), ("\\(", "\\)", false), ("$$", "$$", true), ("$", "$", false)]
            var consumed = false
            for (open, close, display) in delimiters where matches(open, i) && !escaped(i) {
                let content = i + open.count
                if content >= chars.count { continue }
                if open == "$", chars[content].isWhitespace || chars[content] == "$" { continue }
                var end = content
                while end < chars.count {
                    if !display && (chars[end] == "\n" || chars[end] == "`") { break }
                    if matches(close, end), !escaped(end) {
                        if end == content || (open == "$" && (chars[end - 1].isWhitespace || (end + 1 < chars.count && chars[end + 1].isNumber))) { break }
                        let token = "\(prefix)\(equations.count)END"
                        equations[token] = Equation(source: String(chars[i..<(end + close.count)]), display: display, complete: true)
                        output += token; i = end + close.count; consumed = true; break
                    }
                    end += 1
                }
                if !consumed && open != "$" {
                    let token = "\(prefix)\(equations.count)END"
                    equations[token] = Equation(source: String(chars[i..<end]), display: display, complete: false)
                    output += token; i = end; consumed = true
                }
                if consumed { break }
            }
            if !consumed { output.append(chars[i]); i += 1 }
        }
        protected = output
        self.equations = equations
    }

    func hasIncomplete(_ text: String) -> Bool {
        equations.contains { !$0.value.complete && text.contains($0.key) }
    }

    func restore(_ text: String) -> String {
        equations.reduce(text) { $0.replacingOccurrences(of: $1.key, with: $1.value.source) }
    }

    /// Escape literal dollars before handing prose to the math library, whose
    /// dollar recognizer otherwise treats currency as an equation.
    func latex(_ text: String) -> String? {
        guard equations.contains(where: { $0.value.complete && text.contains($0.key) }) else { return nil }
        var escaped = ""
        for char in text {
            if char == "$", escaped.last != "\\" { escaped += "\\" }
            escaped.append(char)
        }
        return restore(escaped)
    }
}
