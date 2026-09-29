import Foundation
import XCTest
@testable import InstantClient

final class ProtocolTests: XCTestCase {
    func testSSEEveryByteBoundaryPreservesUnicodeCRLFAndMultilineData() throws {
        let input = Data("\u{FEFF}: heartbeat\r\nid: ignored\r\nevent: message\r\ndata: 你好 👋\r\ndata: 第二行\r\n\r\ndata: [DONE]\n\n".utf8)
        for split in 0...input.count {
            var parser = SSEParser()
            var events = try parser.feed(input.prefix(split))
            events += try parser.feed(input.dropFirst(split))
            XCTAssertEqual(events, ["你好 👋\n第二行", "[DONE]"], "split at byte \(split)")
        }
        var parser = SSEParser()
        var events: [String] = []
        for byte in input {
            if let event = try parser.feed(byte: byte) { events.append(event) }
        }
        XCTAssertEqual(events, ["你好 👋\n第二行", "[DONE]"])
    }

    func testSSEOnlyDispatchesCompleteEventsAndRemovesOneSpace() throws {
        var parser = SSEParser()
        XCTAssertEqual(try parser.feed(Data("data:  keep leading space\r\rdata\n\ndata: incomplete".utf8)), [" keep leading space", ""])
        XCTAssertEqual(try parser.feed(Data(" event\n".utf8)), [])
        XCTAssertEqual(try parser.feed(Data("\n".utf8)), ["incomplete event"])
    }

    func testSSERejectsInvalidUTF8AndOversizeEvents() throws {
        var parser = SSEParser()
        XCTAssertThrowsError(try parser.feed(Data([0x64, 0x61, 0x74, 0x61, 0x3A, 0xFF, 0x0A]))) {
            XCTAssertEqual($0 as? StreamProtocolError, .invalidUTF8)
        }
        var bounded = SSEParser(maximumEventBytes: 20)
        XCTAssertThrowsError(try bounded.feed(Data("data: 012345678901234567890\n\n".utf8))) {
            XCTAssertEqual($0 as? StreamProtocolError, .eventTooLarge)
        }
    }

    func testReducerTracksLiveStepsInPlaceAndIgnoresMalformedOnes() throws {
        var reducer = UIMessageReducer()
        for event in [
            #"{"type":"start","messageId":"assistant-1"}"#,
            #"{"type":"data-instant-step","id":"cmd-1","transient":true,"data":{"schemaVersion":1,"kind":"command","title":"Run command","detail":"apt-get install g++","status":"in_progress"}}"#,
            #"{"type":"data-instant-step","id":"search-1","transient":true,"data":{"schemaVersion":1,"kind":"search","title":"Search the web","status":"completed"}}"#,
            #"{"type":"data-instant-step","id":"cmd-1","transient":true,"data":{"schemaVersion":1,"kind":"command","title":"Run command","detail":"apt-get install g++","result":"exit 100\nE: permission denied","status":"failed"}}"#,
            #"{"type":"data-instant-step","id":"bad","data":{"schemaVersion":2,"kind":"command","title":"x","status":"completed"}}"#,
            #"{"type":"data-instant-step","data":{"schemaVersion":1,"kind":"note","title":"no id","status":"completed"}}"#,
        ] { try reducer.consume(event) }
        XCTAssertEqual(reducer.state.steps.map(\.id), ["cmd-1", "search-1"])
        XCTAssertEqual(reducer.state.steps.first?.status, "failed")
        XCTAssertEqual(reducer.state.steps.first?.result, "exit 100\nE: permission denied")
        XCTAssertNil(reducer.state.steps.last?.detail)
    }

    func testReducerPreservesTextToolAndDeviceIdentity() throws {
        var reducer = UIMessageReducer()
        for event in [
            #"{"type":"start","messageId":"assistant-1"}"#,
            #"{"type":"data-instant-submission","data":{"schemaVersion":1,"submissionId":"submission-1","status":"running"}}"#,
            #"{"type":"text-start","id":"text-1"}"#,
            #"{"type":"text-delta","id":"text-1","delta":"你好，"}"#,
            #"{"type":"text-delta","id":"text-1","delta":"Instant 👋"}"#,
            #"{"type":"text-end","id":"text-1"}"#,
            #"{"type":"tool-input-available","toolCallId":"call-1","toolName":"instant_test_echo","input":{"text":"👋"}}"#,
            #"{"type":"data-instant-device-request","data":{"schemaVersion":1,"invocationId":"invocation-1","toolCallId":"call-1","deviceId":"device-1","expiresAt":"2026-09-22T00:00:00Z"}}"#,
            #"{"type":"tool-output-available","toolCallId":"call-1","output":{"echo":"👋"}}"#,
            #"{"type":"data-future-extension","data":{"example":true}}"#,
            #"{"type":"data-instant-submission","data":{"schemaVersion":1,"submissionId":"submission-1","status":"completed"}}"#,
            #"{"type":"finish","finishReason":"stop"}"#,
            "[DONE]",
        ] { try reducer.consume(event) }
        try reducer.validateEOF()
        XCTAssertEqual(reducer.state.text, "你好，Instant 👋")
        XCTAssertEqual(reducer.state.messageId, "assistant-1")
        XCTAssertEqual(reducer.state.submissionId, "submission-1")
        XCTAssertEqual(reducer.state.status, "completed")
        XCTAssertEqual(reducer.state.tools["call-1"]?.output, .object(["echo": .string("👋")]))
        XCTAssertEqual(reducer.state.deviceRequests["invocation-1"]?.toolCallId, "call-1")
    }

    func testReducerRejectsMalformedChunksAndInvalidOrder() throws {
        var invalid = UIMessageReducer()
        XCTAssertThrowsError(try invalid.consume("{unfinished"))
        XCTAssertThrowsError(try invalid.consume(#"{"type":"text-delta","id":"x","delta":"x"}"#))
        try invalid.consume(#"{"type":"start","messageId":"m"}"#)
        XCTAssertThrowsError(try invalid.consume(#"{"type":"text-dleta","id":"x","delta":"x"}"#)) {
            XCTAssertEqual($0 as? StreamProtocolError, .malformedChunk("unsupported core chunk: text-dleta"))
        }
        XCTAssertNoThrow(try invalid.consume(#"{"type":"data-future","data":{"optional":true}}"#))
        XCTAssertThrowsError(try invalid.consume(#"{"type":"text-delta","id":"x","delta":"x"}"#))
        XCTAssertThrowsError(try invalid.consume(#"{"type":"tool-output-available","toolCallId":"x","output":null}"#))
        XCTAssertThrowsError(try invalid.consume(#"{"type":"data-instant-submission","data":{"schemaVersion":2,"submissionId":"s","status":"running"}}"#))
        try invalid.consume(#"{"type":"text-start","id":"x"}"#)
        XCTAssertThrowsError(try invalid.consume(#"{"type":"text-start","id":"x"}"#))
        XCTAssertThrowsError(try invalid.consume(#"{"type":"finish"}"#))
    }

    func testEOFRequiresBothFinishAndDONEIncludingAbort() throws {
        var reducer = UIMessageReducer()
        XCTAssertThrowsError(try reducer.validateEOF())
        try reducer.consume(#"{"type":"start","messageId":"m"}"#)
        try reducer.consume(#"{"type":"abort","reason":"cancelled"}"#)
        XCTAssertThrowsError(try reducer.consume("[DONE]"))
        XCTAssertThrowsError(try reducer.validateEOF())
        try reducer.consume(#"{"type":"finish","finishReason":"other"}"#)
        XCTAssertThrowsError(try reducer.validateEOF())
        try reducer.consume("[DONE]")
        try reducer.validateEOF()
        XCTAssertThrowsError(try reducer.consume("[DONE]"))
    }

    func testJSONRoundtripDistinguishesBooleansNullAndNumbers() throws {
        let value: JSONValue = .object(["enabled": .bool(true), "empty": .null, "count": .number(4), "nested": .array([.string("中文 👋")])])
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)), value)
    }

    func testToolDisplayWithoutDeviceRequestNeverExecutes() async throws {
        let client = InstantClient(baseURL: URL(string: "http://127.0.0.1:1")!, bearerToken: "unused")
        let dispatcher = DeviceToolDispatcher(client: client, deviceId: "device-1")
        var reducer = UIMessageReducer()
        try reducer.consume(#"{"type":"start","messageId":"m"}"#)
        try reducer.consume(#"{"type":"tool-input-available","toolCallId":"call-1","toolName":"instant_test_echo","input":{}}"#)
        let receipts = try await dispatcher.dispatchAvailable(in: reducer.state) { _, _ in
            XCTFail("A display event must not execute a device handler")
            return .null
        }
        XCTAssertTrue(receipts.isEmpty)
        try reducer.consume(#"{"type":"data-instant-device-request","data":{"schemaVersion":1,"invocationId":"i","toolCallId":"call-1","deviceId":"other-device","expiresAt":"2026-09-22T00:00:00Z"}}"#)
        let otherDeviceReceipts = try await dispatcher.dispatchAvailable(in: reducer.state) { _, _ in
            XCTFail("A different device must not execute the request")
            return .null
        }
        XCTAssertTrue(otherDeviceReceipts.isEmpty)
    }

    func testUnregisteredToolNeverClaimsOrExecutes() async throws {
        let client = InstantClient(baseURL: URL(string: "http://127.0.0.1:1")!, bearerToken: "unused")
        let dispatcher = DeviceToolDispatcher(client: client, deviceId: "device-1")
        var reducer = UIMessageReducer()
        try reducer.consume(#"{"type":"start","messageId":"m"}"#)
        try reducer.consume(#"{"type":"tool-input-available","toolCallId":"call-1","toolName":"unregistered_tool","input":{}}"#)
        try reducer.consume(#"{"type":"data-instant-device-request","data":{"schemaVersion":1,"invocationId":"i","toolCallId":"call-1","deviceId":"device-1","expiresAt":"2026-09-22T00:00:00Z"}}"#)
        let receipts = try await dispatcher.dispatchAvailable(in: reducer.state) { _, _ in
            XCTFail("An unregistered tool must not execute")
            return .null
        }
        XCTAssertTrue(receipts.isEmpty)
    }
}
