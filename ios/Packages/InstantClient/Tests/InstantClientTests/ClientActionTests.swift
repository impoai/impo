import XCTest
@testable import InstantClient

final class ClientActionTests: XCTestCase {
    private func output(_ name: String = "impo_open_link", parameters: JSONValue = .object(["url": .string("https://youtu.be/example")])) -> JSONValue {
        .object(["kind": .string("client_action"), "schemaVersion": .number(1),
                 "actionId": .string("2b30cd6c-2d20-4f3c-8e98-464974947025"), "capability": .string(name),
                 "execution": .string("device"), "interaction": .string("tap"), "status": .string("ready"), "parameters": parameters])
    }

    func testNativeTargetsRejectUnsafeSchemesAndEncodeNavigationArguments() throws {
        for url in ["javascript:alert(1)", "file:///etc/passwd", "shortcuts://run-shortcut", "https://user:secret@example.com", "https://example.com\\@evil.test"] {
            XCTAssertNil(ClientAction(toolName: "impo_open_link", output: output(parameters: .object(["url": .string(url)]))))
        }
        let action = try XCTUnwrap(ClientAction(toolName: "impo_navigate", output: output("impo_navigate", parameters: .object([
            "destination": .string("Main St & mode=driving"), "mode": .string("walking")]))))
        let target = try XCTUnwrap(URLComponents(url: XCTUnwrap(action.targetURL), resolvingAgainstBaseURL: false))
        XCTAssertEqual(target.host, "maps.apple.com")
        XCTAssertEqual(target.queryItems, [URLQueryItem(name: "daddr", value: "Main St & mode=driving"), URLQueryItem(name: "dirflg", value: "w")])
        XCTAssertNil(ClientAction(toolName: "impo_navigate", output: output()))
        XCTAssertFalse(try XCTUnwrap(ClientAction(toolName: "impo_open_link", output: output(parameters: .object(["url": .string("https://youtube.com.evil.test/")])))).isVideo)
    }

    func testOnlyCompletedKnownToolOutputsRestoreCardsFromStreamAndHistory() throws {
        let data = output()
        let part: JSONValue = .object(["type": .string("dynamic-tool"), "toolName": .string("impo_open_link"),
            "toolCallId": .string("call-1"), "state": .string("output-available"), "output": data])
        let message: JSONValue = .object(["id": .string("message"), "role": .string("assistant"), "sequence": .number(1),
            "text": .string(""), "status": .string("completed"), "createdAt": .string("2026-10-03T00:00:00Z"), "parts": .array([part, part])])
        let history = try JSONDecoder().decode(ConversationMessage.self, from: JSONEncoder().encode(message))
        XCTAssertEqual(history.actions.count, 1)
        var reducer = UIMessageReducer()
        _ = try reducer.consume(#"{"type":"start","messageId":"message"}"#)
        _ = try reducer.consume(#"{"type":"tool-input-available","toolCallId":"call-1","toolName":"impo_open_link","input":{"url":"https://youtu.be/example"}}"#)
        XCTAssertTrue(reducer.state.actions.isEmpty)
        let chunk: JSONValue = .object(["type": .string("tool-output-available"), "toolCallId": .string("call-1"), "output": data])
        _ = try reducer.consume(String(decoding: JSONEncoder().encode(chunk), as: UTF8.self))
        XCTAssertEqual(reducer.state.actions, history.actions)
        XCTAssertTrue(reducer.state.deviceRequests.isEmpty)
        XCTAssertNil(ClientAction(toolName: "cloud_tool", output: data))
        XCTAssertNil(ClientAction.from(part: .object(["type": .string("text"), "output": data])))
    }
}
