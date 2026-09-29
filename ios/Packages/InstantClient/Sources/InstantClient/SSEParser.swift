import Foundation

public enum StreamProtocolError: Error, Equatable, Sendable {
    case invalidUTF8
    case eventTooLarge
    case malformedChunk(String)
    case invalidSequence(String)
    case incompleteStream
    case unsupportedStream
}

/// Parses SSE framing before decoding UTF-8. Network chunks may split any byte.
public struct SSEParser: Sendable {
    private var line: [UInt8] = []
    private var dataLines: [String] = []
    private var dataBytes = 0
    private var skipLF = false
    private var firstLine = true
    private let maximumEventBytes: Int

    public init(maximumEventBytes: Int = 1_048_576) {
        self.maximumEventBytes = maximumEventBytes
    }

    public mutating func feed(_ data: Data) throws -> [String] {
        var events: [String] = []
        for byte in data {
            if let event = try feed(byte: byte) { events.append(event) }
        }
        return events
    }

    public mutating func feed(byte: UInt8) throws -> String? {
        if skipLF {
            skipLF = false
            if byte == 10 { return nil }
        }
        if byte == 13 || byte == 10 {
            skipLF = byte == 13
            return try endLine()
        }
        line.append(byte)
        guard line.count + dataBytes <= maximumEventBytes else {
            throw StreamProtocolError.eventTooLarge
        }
        return nil
    }

    private mutating func endLine() throws -> String? {
        var bytes = line
        line.removeAll(keepingCapacity: true)
        if firstLine {
            firstLine = false
            if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes.removeFirst(3) }
        }
        guard let text = String(bytes: bytes, encoding: .utf8) else {
            throw StreamProtocolError.invalidUTF8
        }
        if text.isEmpty {
            defer { dataLines.removeAll(keepingCapacity: true); dataBytes = 0 }
            return dataLines.isEmpty ? nil : dataLines.joined(separator: "\n")
        }
        guard !text.hasPrefix(":") else { return nil }
        let parts = text.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts[0] == "data" else { return nil }
        var value = parts.count == 2 ? String(parts[1]) : ""
        if value.hasPrefix(" ") { value.removeFirst() }
        dataBytes += value.utf8.count + 1
        guard dataBytes <= maximumEventBytes else { throw StreamProtocolError.eventTooLarge }
        dataLines.append(value)
        return nil
    }
}
