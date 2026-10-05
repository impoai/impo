import Foundation

/// A gadget paired to the signed-in account, as the gadget gateway last saw it.
public struct Gadget: Decodable, Equatable, Identifiable, Sendable {
    public let pairingId: String
    public let nodeId: String
    public let name: String
    public let platform: String?
    public let version: String?
    public let online: Bool
    public var id: String { pairingId }
}

/// Credentials the server issues for one gadget. They go to the gadget over the
/// encrypted BLE setup session and are not stored on the phone.
public struct GadgetPairingRecord: Decodable, Equatable, Sendable {
    public let pairingId: String
    public let accessToken: String
    public let refreshToken: String
    public let apiURL: String
    public let noiseHost: String

    public func provisioning(ssid: String, password: String) -> GadgetProvisioning {
        GadgetProvisioning(ssid: ssid, password: password, accessToken: accessToken, refreshToken: refreshToken, apiURL: apiURL, noiseHost: noiseHost)
    }
}

/// A Wi-Fi network the gadget can see.
public struct GadgetNetwork: Decodable, Equatable, Identifiable, Sendable {
    public let ssid: String
    public let rssi: Int
    public let secure: Bool
    public var id: String { ssid }
}

private struct GadgetList: Decodable { let gadgets: [Gadget] }
private struct GadgetRemoval: Decodable {}

public extension InstantClient {
    func gadgets() async throws -> [Gadget] {
        let list: GadgetList = try await send("GET", ["gadgets"])
        return list.gadgets
    }

    /// Issues credentials for one new gadget on the signed-in account.
    func createGadgetPairing() async throws -> GadgetPairingRecord {
        try await send("POST", ["gadgets", "pairings"], body: .object([:]))
    }

    /// Unpairs a gadget: its credentials stop working and it is disconnected.
    func removeGadget(pairingId: String) async throws {
        let _: GadgetRemoval = try await send("DELETE", ["gadgets", "pairings", pairingId])
    }
}
