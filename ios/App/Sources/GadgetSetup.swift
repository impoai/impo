@preconcurrency import CoreBluetooth
import Foundation
import Observation
import InstantClient

/// Sets up one gadget over Bluetooth: finds it, opens the encrypted setup
/// session, waits for the press on the gadget, then sends it Wi-Fi and a pairing
/// the server issued for the signed-in account. Nothing is kept on the phone.
@MainActor @Observable
final class GadgetSetupModel: NSObject, @preconcurrency CBCentralManagerDelegate, @preconcurrency CBPeripheralDelegate {
    enum Step: Equatable {
        /// Bluetooth is off or not allowed; the text says which.
        case unavailable(String)
        case searching
        case connecting
        /// Waiting for the press on the gadget.
        case confirm
        case wifi
        case joining(String)
        case done
        case failed(String)
    }

    struct Nearby: Identifiable, Equatable {
        let id: UUID
        var name: String
        /// The gadget says it is already set up and must be reset before pairing.
        var isSetUp: Bool
    }

    private(set) var step = Step.searching
    private(set) var nearby: [Nearby] = []
    private(set) var networks: [GadgetNetwork] = []
    private(set) var isScanningWiFi = false
    /// Shown above the Wi-Fi form after a join that did not work.
    private(set) var wifiError: String?
    private(set) var gadgetName = "Gadget"

    @ObservationIgnored private let client: InstantClient
    @ObservationIgnored private var central: CBCentralManager?
    @ObservationIgnored private var peripherals: [UUID: CBPeripheral] = [:]
    @ObservationIgnored private var peripheral: CBPeripheral?
    @ObservationIgnored private var command: CBCharacteristic?
    @ObservationIgnored private var session: GadgetPairingSession?
    @ObservationIgnored private var assembler = GadgetBLE.Assembler()
    @ObservationIgnored private var outgoing: [Data] = []
    @ObservationIgnored private var isWriting = false
    @ObservationIgnored private var record: GadgetPairingRecord?
    /// The gadget has stored its pairing. From here it restarts and drops Bluetooth on its own.
    @ObservationIgnored private var provisioned = false
    @ObservationIgnored private var timeout: Task<Void, Never>?

    private static let service = CBUUID(string: GadgetBLE.service)
    private static let commandUUID = CBUUID(string: GadgetBLE.commandCharacteristic)
    private static let eventUUID = CBUUID(string: GadgetBLE.eventCharacteristic)

    init(client: InstantClient) { self.client = client }

    // MARK: Actions

    /// Creating the manager is what asks for Bluetooth permission, so it waits for the user to start setup.
    func start() {
        stop()
        step = .searching
        nearby = []; peripherals = [:]; networks = []; wifiError = nil; provisioned = false
        central = CBCentralManager(delegate: self, queue: .main)
    }

    func connect(_ gadget: Nearby) {
        guard let central, let target = peripherals[gadget.id] else { return }
        central.stopScan()
        gadgetName = gadget.name
        peripheral = target
        target.delegate = self
        step = .connecting
        central.connect(target)
        expect(within: 20, "The gadget didn't answer. Keep it close and try again.")
    }

    func scanWiFi() {
        guard session?.isEstablished == true, !isScanningWiFi else { return }
        isScanningWiFi = true
        send(sealed: GadgetPairingSession.wifiScanCommand)
    }

    func join(ssid: String, password: String) {
        guard step == .wifi else { return }
        wifiError = nil
        step = .joining("Preparing your gadget…")
        Task {
            do {
                // A retry after a wrong password reuses the pairing already issued for this gadget.
                let record = if let record { record } else { try await client.createGadgetPairing(name: gadgetName) }
                self.record = record
                guard step == .joining("Preparing your gadget…") else { return }
                send(sealed: GadgetPairingSession.provisionCommand(record.provisioning(ssid: ssid, password: password)))
                expect(within: 90, "The gadget didn't finish setting up. Try again.")
            } catch {
                wifiError = "Impo couldn't prepare this gadget. Check your connection and try again."
                if step == .joining("Preparing your gadget…") { step = .wifi }
            }
        }
    }

    /// Ends the attempt. A pairing that no gadget finished setting up is withdrawn.
    func stop() {
        timeout?.cancel(); timeout = nil
        if let record, step != .done {
            let client = client
            Task { try? await client.removeGadget(pairingId: record.pairingId) }
        }
        record = nil
        central?.stopScan()
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        central?.delegate = nil
        central = nil; peripheral = nil; command = nil; session = nil
        assembler = GadgetBLE.Assembler(); outgoing = []; isWriting = false; isScanningWiFi = false
    }

    // MARK: Session

    private func fail(_ message: String) {
        guard step != .done else { return }
        stop()
        step = .failed(message)
    }

    private func awaitOnline(_ pairingId: String) {
        timeout = Task { [weak self, client] in
            for _ in 0..<30 {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { return }
                if (try? await client.gadgets())?.contains(where: { $0.pairingId == pairingId && $0.online }) == true {
                    self?.step = .done
                    return
                }
            }
            guard !Task.isCancelled, let self else { return }
            let name = self.gadgetName
            self.stop()
            self.step = .failed("\(name) joined that Wi-Fi but couldn't reach Impo from it. It stays in your Gadgets list and connects when it can. To use another network, remove it there and set it up again.")
        }
    }

    private func expect(within seconds: Int, _ message: String) {
        timeout?.cancel()
        timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            self?.fail(message)
        }
    }

    private func send(_ message: Data) {
        guard let peripheral else { return }
        outgoing += GadgetBLE.packets(for: message, maximumWriteLength: peripheral.maximumWriteValueLength(for: .withResponse))
        writeNext()
    }

    private func send(sealed commandData: Data) {
        guard let message = try? session?.seal(commandData) else { return fail("The setup session ended. Try again.") }
        send(message)
    }

    private func writeNext() {
        guard !isWriting, !outgoing.isEmpty, let peripheral, let command else { return }
        isWriting = true
        peripheral.writeValue(outgoing.removeFirst(), for: command, type: .withResponse)
    }

    private func receive(_ message: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: message) as? [String: Any], let type = object["type"] as? String else { return }
        do {
            switch type {
            case "device_info":
                guard session == nil else { return }
                let info = try JSONDecoder().decode(GadgetInfo.self, from: message)
                let session = try GadgetPairingSession(info: info)
                self.session = session
                send(session.hello())
            case "pairing_ready":
                try session?.accept(ready: message)
                send(sealed: GadgetPairingSession.clientFinishedCommand)
            case "pairing_encrypted":
                guard let event = try session?.open(message) else { return }
                if let status = GadgetPairingSession.status(of: event) { handle(status: status) }
                else if let found = GadgetPairingSession.networks(of: event) { networks = found; isScanningWiFi = false }
            case "status":
                if let status = object["status"] as? String { handle(status: status) }
            default: break
            }
        } catch GadgetPairingError.unsupportedGadget {
            fail("This gadget's firmware isn't supported by this version of Impo.")
        } catch {
            fail("The gadget's setup session couldn't be verified. Try again.")
        }
    }

    private func handle(status: String) {
        switch status {
        case "confirm_required":
            step = .confirm
            expect(within: 75, "The gadget's button wasn't pressed in time. Try again.")
        case "pairing_confirmed":
            timeout?.cancel()
            step = .wifi
            scanWiFi()
        case "wifi_connecting": step = .joining("Joining Wi-Fi…")
        case "wifi_connected": step = .joining("Connecting to Impo…")
        case "auth_ok":
            // The gadget has only stored the pairing. It is set up once it reaches Impo over its own Wi-Fi.
            guard let pairingId = record?.pairingId else { return }
            timeout?.cancel()
            provisioned = true
            record = nil
            step = .joining("Waiting for \(gadgetName) to come online…")
            awaitOnline(pairingId)
        case "wifi_failed":
            timeout?.cancel()
            wifiError = "The gadget couldn't join that network. Check the name and password."
            step = .wifi
        case "auth_failed": fail("The gadget joined Wi-Fi but couldn't reach Impo. Try again.")
        case "pairing_confirm_timeout": fail("The gadget's button wasn't pressed in time. Try again.")
        case "error_pairing_unavailable": fail("This gadget is already set up. Hold its button for 5 seconds to reset it, then try again.")
        case "error_missing_credentials":
            wifiError = "Enter the Wi-Fi password. Open networks aren't supported."
            step = .wifi
        default:
            if status.hasPrefix("error_") { fail("The gadget reported a setup problem (\(status.dropFirst(6))). Try again.") }
        }
    }

    // MARK: CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            guard peripheral == nil else { return }
            step = .searching
            central.scanForPeripherals(withServices: [Self.service])
        case .unauthorized: step = .unavailable("Allow Bluetooth for Impo in Settings to set up a gadget.")
        case .poweredOff: step = .unavailable("Turn on Bluetooth to set up a gadget.")
        case .unsupported: step = .unavailable("This device can't use Bluetooth.")
        default: break
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        peripherals[peripheral.identifier] = peripheral
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name
        // Manufacturer data is a test company id followed by one "already set up" byte.
        let manufacturer = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data
        let isSetUp = manufacturer.map { $0.count >= 3 && $0[$0.startIndex + 2] == 1 }
        if let index = nearby.firstIndex(where: { $0.id == peripheral.identifier }) {
            if let name { nearby[index].name = name }
            if let isSetUp { nearby[index].isSetUp = isSetUp }
        } else {
            nearby.append(Nearby(id: peripheral.identifier, name: name ?? "Gadget", isSetUp: isSetUp ?? false))
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices([Self.service])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: (any Error)?) {
        fail("Impo couldn't connect to the gadget. Keep it close and try again.")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: (any Error)?) {
        // The gadget turns Bluetooth off itself once it has stored its pairing.
        if provisioned { return }
        if case .failed = step { return }
        fail("The gadget disconnected before setup finished. Try again.")
    }

    // MARK: CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: (any Error)?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == Self.service }) else { return fail("This doesn't look like an Impo gadget.") }
        peripheral.discoverCharacteristics([Self.commandUUID, Self.eventUUID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: (any Error)?) {
        command = service.characteristics?.first { $0.uuid == Self.commandUUID }
        guard command != nil, let events = service.characteristics?.first(where: { $0.uuid == Self.eventUUID }) else { return fail("This doesn't look like an Impo gadget.") }
        peripheral.setNotifyValue(true, for: events)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: (any Error)?) {
        guard error == nil, characteristic.isNotifying else { return fail("Impo couldn't listen to the gadget. Try again.") }
        send(GadgetPairingSession.deviceInfoCommand)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: (any Error)?) {
        guard characteristic.uuid == Self.eventUUID, let packet = characteristic.value, let message = assembler.receive(packet) else { return }
        receive(message)
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: (any Error)?) {
        isWriting = false
        if error != nil { return fail("The gadget stopped responding. Try again.") }
        writeNext()
    }
}
