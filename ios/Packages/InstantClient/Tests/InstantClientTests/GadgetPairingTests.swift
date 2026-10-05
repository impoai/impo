import CryptoKit
import Foundation
import XCTest
@testable import InstantClient

/// Community vectors from the gadget SDK's `link_pairing_v5.json`: the phone
/// must produce exactly the records the reference firmware expects.
final class GadgetPairingTests: XCTestCase {
    struct Vector {
        let policy, deviceId, nodeId, mac, firmware, mobileScalar, mobileNonce, mobilePub: String
        let devicePub, deviceNonce, transcriptHash, sessionId, deviceToMobileKey, finishedCiphertext, finishedTag: String
    }
    static let vectors = [
        Vector(policy: "confirm_press", deviceId: "hatch-link:02:00:00:00:00:01", nodeId: "homelink-000001", mac: "02:00:00:00:00:01", firmware: "1.0.0",
               mobileScalar: "0000000000000000000000000000000000000000000000000000000000000001", mobileNonce: "AAECAwQFBgcICQoLDA0ODw", mobilePub: "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
               devicePub: "BHzyexiNA09-ilI4AwS1GsPAiWnid_IbNaYLSPxHZpl4B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E", deviceNonce: "EBESExQVFhcYGRobHB0eHw", transcriptHash: "4JPG41T-py33iUwUikEuwGB9fRWtuCVZ487wR9rmf_0", sessionId: "9ZhHd6Rbkqedw5ffaHFDBA",
               deviceToMobileKey: "2208c6d80caa35cd71a5d89ae5f1bf0856e01def5a5e23c82aba926847631e0c", finishedCiphertext: "LO2pD7qlezotlO0Ouabt8DJxV9hOKXgbwZIOrDoxNh-MouF8", finishedTag: "WLUUWnL6UoWRaJ5Wd5jXhw"),
        Vector(policy: "confirm_app", deviceId: "hatch-link:02:00:00:00:00:01", nodeId: "homelink-000001", mac: "02:00:00:00:00:01", firmware: "1.0.0",
               mobileScalar: "0000000000000000000000000000000000000000000000000000000000000001", mobileNonce: "AAECAwQFBgcICQoLDA0ODw", mobilePub: "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
               devicePub: "BHzyexiNA09-ilI4AwS1GsPAiWnid_IbNaYLSPxHZpl4B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E", deviceNonce: "EBESExQVFhcYGRobHB0eHw", transcriptHash: "18Rs196tzddPGuj18pZ8rWObWYpwoDUIwocjnUASj_0", sessionId: "z0eNLGw5mczvD4a1F2ubSQ",
               deviceToMobileKey: "9abb2954b05e2f5f7112e9bfd41fd970602e27ed07453c1cff51f575de5d0b4e", finishedCiphertext: "uwNX3KEkix5T6nWce3s2SKPPh-5E31x-UIHFSK6MpMUg562B", finishedTag: "zT4kU6XK-rM7rvt3VEITLg"),
    ]

    private func info(_ v: Vector, policy: String? = nil) -> GadgetInfo {
        try! JSONDecoder().decode(GadgetInfo.self, from: GadgetPairingSession.json([
            "type": "device_info", "node_id": v.nodeId, "device_id": v.deviceId, "mac": v.mac, "model": "hatch_link", "version": v.firmware,
            "pairing_protocol": 5, "pairing_auth": "none", "pairing_auth_epoch": 0, "pairing_policy": policy ?? v.policy, "network_ready": true,
        ]))
    }

    private func ready(_ v: Vector, _ changes: [String: Any] = [:]) -> Data {
        var message: [String: Any] = [
            "type": "pairing_ready", "version": 5, "device_id": v.deviceId, "node_id": v.nodeId, "mac": v.mac, "model": "hatch_link",
            "firmware_version": v.firmware, "pairing_auth": "none", "pairing_auth_epoch": 0, "pairing_policy": v.policy,
            "device_pub": v.devicePub, "device_nonce": v.deviceNonce, "transcript_hash": v.transcriptHash, "session_id": v.sessionId,
        ]
        message.merge(changes) { _, new in new }
        return GadgetPairingSession.json(message)
    }

    private func session(_ v: Vector) throws -> GadgetPairingSession {
        try GadgetPairingSession(info: info(v), privateKey: P256.KeyAgreement.PrivateKey(rawRepresentation: Data(hex: v.mobileScalar)),
                                 nonce: XCTUnwrap(GadgetPairingSession.data(base64URL: v.mobileNonce)))
    }

    func testHelloAndClientFinishedMatchTheReferenceVectors() throws {
        for v in Self.vectors {
            var session = try session(v)
            let hello = try XCTUnwrap(JSONSerialization.jsonObject(with: session.hello()) as? [String: Any])
            XCTAssertEqual(hello["action"] as? String, "pairing_client_hello")
            XCTAssertEqual(hello["version"] as? Int, 5)
            XCTAssertEqual(hello["pairing_policy"] as? String, v.policy)
            XCTAssertEqual(hello["mobile_pub"] as? String, v.mobilePub)
            XCTAssertEqual(hello["mobile_nonce"] as? String, v.mobileNonce)

            try session.accept(ready: ready(v))
            let record = try XCTUnwrap(JSONSerialization.jsonObject(with: session.seal(GadgetPairingSession.clientFinishedCommand)) as? [String: String])
            XCTAssertEqual(record, ["action": "pairing_encrypted", "session_id": v.sessionId, "counter": "0",
                                    "ciphertext": v.finishedCiphertext, "tag": v.finishedTag], v.policy)
        }
    }

    func testOpensGadgetRecordsInOrderOnly() throws {
        let v = Self.vectors[0]
        var session = try session(v)
        try session.accept(ready: ready(v))
        let key = SymmetricKey(data: Data(hex: v.deviceToMobileKey))
        func record(_ counter: UInt64, _ text: String) throws -> Data {
            var nonce = Data([1, 0, 0, 0]); withUnsafeBytes(of: counter.bigEndian) { nonce.append(contentsOf: $0) }
            let box = try AES.GCM.seal(Data(text.utf8), using: key, nonce: AES.GCM.Nonce(data: nonce),
                                       authenticating: Data("hatch-link ble setup v1|\(v.sessionId)|d2m|\(counter)".utf8))
            return GadgetPairingSession.json(["type": "pairing_encrypted", "session_id": v.sessionId, "counter": String(counter),
                                              "ciphertext": GadgetPairingSession.base64URL(box.ciphertext), "tag": GadgetPairingSession.base64URL(box.tag)])
        }
        let confirmed = try session.open(record(0, #"{"type":"status","status":"pairing_confirmed"}"#))
        XCTAssertEqual(GadgetPairingSession.status(of: confirmed), "pairing_confirmed")
        XCTAssertThrowsError(try session.open(record(0, "{}")), "a replayed record") { XCTAssertEqual($0 as? GadgetPairingError, .recordRejected) }
        XCTAssertThrowsError(try session.open(record(2, "{}")), "a skipped record")
        XCTAssertEqual(GadgetPairingSession.status(of: try session.open(record(1, #"{"type":"status","status":"auth_ok"}"#))), "auth_ok")
    }

    func testRejectsAnAlteredExchangeAndUnsupportedGadgets() throws {
        let v = Self.vectors[0]
        var altered = try session(v)
        XCTAssertThrowsError(try altered.accept(ready: ready(v, ["node_id": "homelink-ffffff"]))) { XCTAssertEqual($0 as? GadgetPairingError, .transcriptMismatch) }
        XCTAssertFalse(altered.isEstablished)
        XCTAssertThrowsError(try altered.seal(GadgetPairingSession.clientFinishedCommand))
        var wrongPolicy = try session(v)
        XCTAssertThrowsError(try wrongPolicy.accept(ready: ready(v, ["pairing_policy": "confirm_app"]))) { XCTAssertEqual($0 as? GadgetPairingError, .unsupportedGadget) }
        XCTAssertThrowsError(try GadgetPairingSession(info: info(v, policy: "something_else"))) { XCTAssertEqual($0 as? GadgetPairingError, .unsupportedGadget) }
        XCTAssertTrue(info(v).confirmsWithButton)
    }

    func testProvisioningCommandCarriesWifiAndPairing() throws {
        let command = GadgetPairingSession.provisionCommand(GadgetProvisioning(ssid: "home", password: "secret", accessToken: "a", refreshToken: "r",
                                                                              apiURL: "https://gadgets.impo.ai", noiseHost: "gadgets.impo.ai"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: command) as? [String: String])
        XCTAssertEqual(object, ["action": "provision_v2", "ssid": "home", "password": "secret", "access_token": "a", "refresh_token": "r",
                                "token_type": "device", "username": "", "api_url_v2": "https://gadgets.impo.ai", "noise_host": "gadgets.impo.ai"])
    }

    func testWifiScanResultsAreDeduplicatedAndSortedByStrength() throws {
        let event = Data(#"{"type":"wifi_scan_result","networks":[{"ssid":"Far","rssi":-80,"secure":true},{"ssid":"Home","rssi":-70,"secure":true},{"ssid":"","rssi":-20,"secure":false},{"ssid":"Home","rssi":-40,"secure":true}]}"#.utf8)
        XCTAssertEqual(GadgetPairingSession.networks(of: event)?.map(\.ssid), ["Home", "Far"])
        XCTAssertEqual(GadgetPairingSession.networks(of: event)?.first?.rssi, -40)
        XCTAssertNil(GadgetPairingSession.networks(of: Data(#"{"type":"status","status":"auth_ok"}"#.utf8)))
    }

    func testAPairingRecordBecomesTheProvisioningCommand() throws {
        let record = try JSONDecoder().decode(GadgetPairingRecord.self, from: Data(#"{"pairingId":"p1","accessToken":"a","refreshToken":"r","apiURL":"https://gadgets.example","noiseHost":"gadgets.example"}"#.utf8))
        let command = try XCTUnwrap(JSONSerialization.jsonObject(with: GadgetPairingSession.provisionCommand(record.provisioning(ssid: "Home", password: "secret"))) as? [String: String])
        XCTAssertEqual(command["access_token"], "a")
        XCTAssertEqual(command["refresh_token"], "r")
        XCTAssertEqual(command["api_url_v2"], "https://gadgets.example")
        XCTAssertEqual(command["noise_host"], "gadgets.example")
        XCTAssertEqual(command["ssid"], "Home")
    }

    func testFramingSplitsAndReassemblesMessages() {
        let message = Data((0..<500).map { UInt8($0 % 251) })
        let packets = GadgetBLE.packets(for: message, maximumWriteLength: 182)
        XCTAssertEqual(packets.count, 4)   // 157 payload bytes per packet: capped at 160 including the header
        XCTAssertTrue(packets.allSatisfy { $0.count <= 160 && $0[0] == 0xFE })
        var assembler = GadgetBLE.Assembler()
        XCTAssertNil(assembler.receive(packets[0]))
        XCTAssertNil(assembler.receive(packets[1]))
        XCTAssertNil(assembler.receive(packets[2]))
        XCTAssertEqual(assembler.receive(packets[3]), message)
        XCTAssertEqual(assembler.receive(Data("error_pairing_decrypt".utf8)), Data("error_pairing_decrypt".utf8), "an unframed status")
        XCTAssertNil(assembler.receive(packets[0]))
        XCTAssertNil(assembler.receive(packets[2]), "an out-of-order chunk discards the message")
        XCTAssertEqual(GadgetBLE.packets(for: Data(), maximumWriteLength: 20), [Data([0xFE, 0, 1])])
    }
}

private extension Data {
    init(hex: String) {
        self.init(stride(from: 0, to: hex.count, by: 2).map { offset in
            UInt8(hex[hex.index(hex.startIndex, offsetBy: offset)..<hex.index(hex.startIndex, offsetBy: offset + 2)], radix: 16)!
        })
    }
}
