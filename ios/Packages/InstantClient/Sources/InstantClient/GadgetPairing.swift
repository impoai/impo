import CryptoKit
import Foundation

/// The phone side of gadget BLE setup, protocol version 5, as spoken by the
/// open-source gadget firmware. This file is transport-free: it produces and
/// consumes the JSON messages and BLE packets; CoreBluetooth carries them.
///
/// Community pairing hides setup secrets from passive observers. It does not
/// authenticate the gadget, so it cannot stop an active man-in-the-middle.
public enum GadgetBLE {
    public static let service = "7FDD3D1C-38EA-46CF-8B46-314ECF5F240C"
    /// Written by the phone.
    public static let commandCharacteristic = "4D593029-28A2-4A6E-A1F0-3C2D5E8F9B01"
    /// Notified by the gadget.
    public static let eventCharacteristic = "D75DC4CA-7B2B-4E9C-8F0A-1D2E3F4A5B6C"
    public static let namePrefix = "ImpoGadget"

    static let chunkMagic: UInt8 = 0xFE
    static let maxPacketBytes = 160
    static let maxMessageBytes = 8192

    /// Splits a message into packets that each fit one write of `maximumWriteLength` bytes.
    public static func packets(for message: Data, maximumWriteLength: Int) -> [Data] {
        let usable = max(1, min(maximumWriteLength, maxPacketBytes) - 3)
        let count = max(1, (message.count + usable - 1) / usable)
        precondition(count <= 255, "message too large for gadget framing")
        return (0..<count).map { index in
            let start = message.startIndex + index * usable
            let end = min(start + usable, message.endIndex)
            return Data([chunkMagic, UInt8(index), UInt8(count)]) + message[start..<end]
        }
    }

    /// Reassembles notifications, strictly in order. A packet that does not
    /// start with the chunk marker is a complete message.
    public struct Assembler: Sendable {
        private var buffer = Data()
        private var total = 0
        private var next = 0

        public init() {}

        public mutating func receive(_ packet: Data) -> Data? {
            guard packet.count >= 3, packet.first == chunkMagic else { return packet }
            let index = Int(packet[packet.startIndex + 1]), count = Int(packet[packet.startIndex + 2])
            if count == 0 { reset(); return nil }
            if index == 0 || count != total { reset(); total = count }
            guard index == next, index < total, buffer.count + packet.count - 3 <= maxMessageBytes else { reset(); return nil }
            buffer.append(packet.dropFirst(3))
            next = index + 1
            guard next == total else { return nil }
            defer { reset() }
            return buffer
        }

        private mutating func reset() { buffer = Data(); total = 0; next = 0 }
    }
}

public enum GadgetPairingError: Error, Equatable {
    /// The gadget's reply was not the expected message.
    case unexpectedMessage
    /// The gadget is not one this app can pair: wrong protocol, model or policy.
    case unsupportedGadget
    /// The gadget and the phone disagree about what was exchanged.
    case transcriptMismatch
    /// A record could not be opened, or arrived out of order.
    case recordRejected
    /// The gadget reported a setup error by this wire status.
    case gadget(String)
}

/// Public facts a gadget reports before pairing.
public struct GadgetInfo: Decodable, Equatable, Sendable {
    public let nodeId: String
    public let deviceId: String
    public let mac: String
    public let model: String
    public let version: String
    public let pairingProtocol: Int
    public let pairingAuth: String
    public let pairingPolicy: String
    public let networkReady: Bool?

    enum CodingKeys: String, CodingKey {
        case nodeId = "node_id", deviceId = "device_id", mac, model, version
        case pairingProtocol = "pairing_protocol", pairingAuth = "pairing_auth", pairingPolicy = "pairing_policy"
        case networkReady = "network_ready"
    }

    /// Whether the gadget confirms pairing with its own button rather than in the app.
    public var confirmsWithButton: Bool { pairingPolicy == GadgetPairingSession.buttonPolicy }
}

/// What the gadget stores to reach its account: Wi-Fi and the gateway pairing.
public struct GadgetProvisioning: Equatable, Sendable {
    public var ssid: String
    public var password: String
    public var accessToken: String
    public var refreshToken: String
    public var apiURL: String
    public var noiseHost: String
    public var username: String

    public init(ssid: String, password: String, accessToken: String, refreshToken: String, apiURL: String, noiseHost: String, username: String = "") {
        self.ssid = ssid; self.password = password
        self.accessToken = accessToken; self.refreshToken = refreshToken
        self.apiURL = apiURL; self.noiseHost = noiseHost; self.username = username
    }
}

/// One pairing attempt. Call `hello()`, feed the gadget's `pairing_ready` to
/// `accept(ready:)`, then exchange commands and events as sealed records.
public struct GadgetPairingSession: Sendable {
    static let version = 5
    static let model = "hatch_link"
    static let suite = "p256-hkdf-sha256-aes-gcm-v1"
    static let buttonPolicy = "confirm_press"
    static let appPolicy = "confirm_app"
    static let communityAuth = "none"
    static let recordLabel = "hatch-link ble setup v1"

    private let privateKey: P256.KeyAgreement.PrivateKey
    private let nonce: Data
    private let policy: String
    private var keys: (send: SymmetricKey, receive: SymmetricKey, sessionId: String)?
    private var sendCounter: UInt64 = 0
    private var receiveCounter: UInt64 = 0

    /// Starts an attempt for a gadget whose `info` this app supports.
    public init(info: GadgetInfo) throws {
        try self.init(info: info, privateKey: P256.KeyAgreement.PrivateKey(), nonce: Data((0..<16).map { _ in UInt8.random(in: .min ... .max) }))
    }

    init(info: GadgetInfo, privateKey: P256.KeyAgreement.PrivateKey, nonce: Data) throws {
        guard info.pairingProtocol == Self.version, info.model == Self.model, info.pairingAuth == Self.communityAuth,
              [Self.buttonPolicy, Self.appPolicy].contains(info.pairingPolicy), nonce.count == 16 else {
            throw GadgetPairingError.unsupportedGadget
        }
        self.privateKey = privateKey
        self.nonce = nonce
        self.policy = info.pairingPolicy
    }

    public var isEstablished: Bool { keys != nil }

    /// The `pairing_client_hello` command, sent in plaintext.
    public func hello() -> Data {
        Self.json([
            "action": "pairing_client_hello", "version": Self.version, "pairing_auth": Self.communityAuth, "pairing_policy": policy,
            "mobile_pub": Self.base64URL(privateKey.publicKey.x963Representation), "mobile_nonce": Self.base64URL(nonce),
        ])
    }

    /// Checks the gadget's `pairing_ready` against what this phone sent and derives the record keys.
    public mutating func accept(ready message: Data) throws {
        guard let ready = try? JSONSerialization.jsonObject(with: message) as? [String: Any], ready["type"] as? String == "pairing_ready" else {
            throw GadgetPairingError.unexpectedMessage
        }
        func text(_ key: String) throws -> String {
            guard let value = ready[key] as? String, !value.isEmpty else { throw GadgetPairingError.unexpectedMessage }
            return value
        }
        guard ready["version"] as? Int == Self.version, try text("pairing_auth") == Self.communityAuth, try text("pairing_policy") == policy,
              try text("model") == Self.model, ready["pairing_auth_epoch"] as? Int == 0,
              let devicePoint = Self.data(base64URL: try text("device_pub")), let deviceNonce = Self.data(base64URL: try text("device_nonce")), deviceNonce.count == 16,
              let deviceKey = try? P256.KeyAgreement.PublicKey(x963Representation: devicePoint),
              let secret = try? privateKey.sharedSecretFromKeyAgreement(with: deviceKey) else {
            throw GadgetPairingError.unsupportedGadget
        }
        let transcript = [
            "hatch-link-pairing-v\(Self.version)", "version=\(Self.version)", "initiator_role=mobile", "responder_role=link",
            "device_id=\(try text("device_id"))", "node_id=\(try text("node_id"))", "mac=\(try text("mac"))", "model=\(Self.model)",
            "firmware_version=\(try text("firmware_version"))", "selected_cipher_suite=\(Self.suite)",
            "pairing_auth=\(Self.communityAuth)", "pairing_auth_epoch=0", "pairing_policy=\(policy)",
            "confirm_timeout_seconds=\(policy == Self.buttonPolicy ? 60 : 0)",
            "mobile_pub=\(Self.base64URL(privateKey.publicKey.x963Representation))", "device_pub=\(try text("device_pub"))",
            "mobile_nonce=\(Self.base64URL(nonce))", "device_nonce=\(try text("device_nonce"))",
        ].joined(separator: "\n")
        let transcriptHash = Data(SHA256.hash(data: Data(transcript.utf8)))
        let secretBytes = secret.withUnsafeBytes { Data($0) }
        let sessionId = Self.base64URL(Data(SHA256.hash(data: Data("hatch-link session id v1".utf8) + transcriptHash + secretBytes)).prefix(16))
        // The gadget states its own view of both; a difference means the exchange was altered.
        guard try text("transcript_hash") == Self.base64URL(transcriptHash), try text("session_id") == sessionId else {
            throw GadgetPairingError.transcriptMismatch
        }
        let salt = Data(SHA256.hash(data: nonce + deviceNonce + transcriptHash))
        let sessionSecret = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: secretBytes), salt: salt, info: Data(Self.recordLabel.utf8), outputByteCount: 32)
        func expand(_ info: String) -> SymmetricKey {
            HKDF<SHA256>.expand(pseudoRandomKey: sessionSecret, info: Data(info.utf8), outputByteCount: 32)
        }
        keys = (expand("mobile->device"), expand("device->mobile"), sessionId)
        sendCounter = 0
        receiveCounter = 0
    }

    /// Seals one command as a `pairing_encrypted` message for the gadget.
    public mutating func seal(_ command: Data) throws -> Data {
        guard let keys else { throw GadgetPairingError.recordRejected }
        let counter = sendCounter
        let box = try AES.GCM.seal(command, using: keys.send, nonce: Self.nonce(direction: 0, counter: counter),
                                   authenticating: Self.associatedData(sessionId: keys.sessionId, arrow: "m2d", counter: counter))
        sendCounter += 1
        return Self.json(["action": "pairing_encrypted", "session_id": keys.sessionId, "counter": String(counter),
                          "ciphertext": Self.base64URL(box.ciphertext), "tag": Self.base64URL(box.tag)])
    }

    /// Opens one `pairing_encrypted` message from the gadget. Records must arrive in order.
    public mutating func open(_ message: Data) throws -> Data {
        guard let keys, let envelope = try? JSONSerialization.jsonObject(with: message) as? [String: Any],
              envelope["type"] as? String == "pairing_encrypted", envelope["session_id"] as? String == keys.sessionId,
              let counterText = envelope["counter"] as? String, let counter = UInt64(counterText), counter == receiveCounter,
              let ciphertext = Self.data(base64URL: envelope["ciphertext"] as? String ?? ""), let tag = Self.data(base64URL: envelope["tag"] as? String ?? ""),
              let box = try? AES.GCM.SealedBox(nonce: Self.nonce(direction: 1, counter: counter), ciphertext: ciphertext, tag: tag),
              let plaintext = try? AES.GCM.open(box, using: keys.receive, authenticating: Self.associatedData(sessionId: keys.sessionId, arrow: "d2m", counter: counter)) else {
            throw GadgetPairingError.recordRejected
        }
        receiveCounter += 1
        return plaintext
    }

    // MARK: Commands

    public static let deviceInfoCommand = json(["action": "get_device_info"])
    public static let clientFinishedCommand = Data(#"{"action":"pairing_client_finished"}"#.utf8)
    public static let wifiScanCommand = json(["action": "wifi_scan"])

    public static func provisionCommand(_ provisioning: GadgetProvisioning) -> Data {
        json(["action": "provision_v2", "ssid": provisioning.ssid, "password": provisioning.password,
              "access_token": provisioning.accessToken, "refresh_token": provisioning.refreshToken, "token_type": "device",
              "username": provisioning.username, "api_url_v2": provisioning.apiURL, "noise_host": provisioning.noiseHost])
    }

    /// The wire status of a decrypted `{"type":"status"}` event, such as
    /// `pairing_confirmed`, `wifi_connected`, `wifi_failed` or `auth_ok`.
    public static func status(of event: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: event) as? [String: Any], object["type"] as? String == "status" else { return nil }
        return object["status"] as? String
    }

    // MARK: Encoding

    private static func nonce(direction: UInt8, counter: UInt64) -> AES.GCM.Nonce {
        var bytes = Data([direction, 0, 0, 0])
        withUnsafeBytes(of: counter.bigEndian) { bytes.append(contentsOf: $0) }
        return try! AES.GCM.Nonce(data: bytes)
    }

    private static func associatedData(sessionId: String, arrow: String, counter: UInt64) -> Data {
        Data("\(recordLabel)|\(sessionId)|\(arrow)|\(counter)".utf8)
    }

    static func json(_ object: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func data(base64URL text: String) -> Data? {
        guard !text.isEmpty, text.count % 4 != 1, text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        let padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - text.count % 4) % 4)
        return Data(base64Encoded: padded)
    }
}
