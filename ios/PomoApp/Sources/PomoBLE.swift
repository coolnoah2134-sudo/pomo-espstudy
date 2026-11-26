import Foundation
import Combine
import CoreBluetooth

// MARK: - Connection state

enum PomoConnectionState: Equatable {
    case idle
    case scanning
    case connecting
    case discovering
    case connected
    case failed(String)

    var label: String {
        switch self {
        case .idle: return "Bluetooth idle"
        case .scanning: return "Scanning…"
        case .connecting: return "Connecting…"
        case .discovering: return "Discovering…"
        case .connected: return "Connected"
        case .failed(let message): return message
        }
    }

    var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }
}

// MARK: - CoreBluetooth client

/// Native iOS client for the espstudy ESP32-C3 timer.
///
/// Protocol mirrors the website and firmware exactly:
/// - Service: 7b6e0001-8d2a-4c6f-9a31-5f2c8e4d1000
/// - Status:  7b6e0002-8d2a-4c6f-9a31-5f2c8e4d1000 (read + notify)
/// - Command: 7b6e0003-8d2a-4c6f-9a31-5f2c8e4d1000 (write with response)
/// - Frames:  [generation, sequence, total, payloadLength] + up to 13 payload bytes
final class PomoBLE: NSObject, ObservableObject {
    private static let serviceUUID = CBUUID(string: "7b6e0001-8d2a-4c6f-9a31-5f2c8e4d1000")
    private static let statusUUID = CBUUID(string: "7b6e0002-8d2a-4c6f-9a31-5f2c8e4d1000")
    private static let commandUUID = CBUUID(string: "7b6e0003-8d2a-4c6f-9a31-5f2c8e4d1000")

    private static let frameHeader = 4
    private static let framePayload = 13
    private static let maxFrames = 16

    @Published var status = PomoStatus()
    @Published var lastStatusAt = Date()
    @Published var connection: PomoConnectionState = .idle
    @Published var deviceName: String?
    @Published var lastMessage: String?

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var statusCharacteristic: CBCharacteristic?
    private var commandCharacteristic: CBCharacteristic?
    private var scanTimer: Timer?

    // Commands are serialised so framed writes never interleave.
    private var frameQueue: [Data] = []
    private var isWriting = false

    // Incoming status reassembly.
    private var rxGeneration: UInt8?
    private var rxTotal = 0
    private var rxParts: [Int: Data] = [:]

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }

    deinit {
        scanTimer?.invalidate()
        central?.stopScan()
    }

    // MARK: Public API

    func connect() {
        guard central.state == .poweredOn else {
            connection = .failed("Bluetooth \(Self.stateText(central.state))")
            return
        }
        guard peripheral == nil else { return }

        deviceName = nil
        lastMessage = nil
        connection = .scanning

        central.scanForPeripherals(
            withServices: [Self.serviceUUID],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )

        scanTimer?.invalidate()
        scanTimer = Timer.scheduledTimer(withTimeInterval: 12, repeats: false) { [weak self] _ in
            guard let self, self.connection == .scanning else { return }
            self.central.stopScan()
            self.connection = .failed("No espstudy device found")
        }
    }

    func disconnect() {
        scanTimer?.invalidate()
        central.stopScan()

        if let peripheral {
            peripheral.delegate = nil
            central.cancelPeripheralConnection(peripheral)
        }
        clearPeripheral()
        connection = .idle
        deviceName = nil
        lastMessage = nil
    }

    func send(_ command: PomoCommand) {
        guard connection.isConnected,
              peripheral != nil,
              commandCharacteristic != nil else {
            lastMessage = "Connect to espstudy first"
            return
        }

        frameQueue.append(contentsOf: Self.frames(for: command.data))
        pumpWrites()
    }

    func refreshStatus() {
        send(.status)
    }

    // MARK: Command framing

    private static func frames(for json: Data) -> [Data] {
        let total = max(1, min(maxFrames, (json.count + framePayload - 1) / framePayload))
        let generation = UInt8.random(in: 1...255)

        return (0..<total).map { sequence in
            let start = sequence * framePayload
            let end = min(start + framePayload, json.count)
            let chunk = Data(json[start..<end])

            var frame = Data([
                generation,
                UInt8(sequence),
                UInt8(total),
                UInt8(chunk.count),
            ])
            frame.append(chunk)
            return frame
        }
    }

    private func pumpWrites() {
        guard !isWriting,
              !frameQueue.isEmpty,
              let peripheral,
              let commandCharacteristic else { return }

        isWriting = true
        let frame = frameQueue.removeFirst()
        peripheral.writeValue(frame, for: commandCharacteristic, type: .withResponse)
    }

    // MARK: Status framing

    private func handleIncoming(_ data: Data) {
        guard !data.isEmpty else { return }

        // Large-MTU peers may send the full JSON object in one value.
        if data.first == 0x7B {
            parseStatus(data)
            return
        }

        guard data.count >= Self.frameHeader else { return }

        let generation = data[0]
        let sequence = Int(data[1])
        let total = Int(data[2])
        let payloadLength = Int(data[3])

        guard payloadLength <= Self.framePayload,
              data.count == Self.frameHeader + payloadLength,
              total >= 1,
              total <= Self.maxFrames,
              sequence < total else { return }

        if rxGeneration == nil || generation != rxGeneration || sequence == 0 {
            rxGeneration = generation
            rxTotal = total
            rxParts = [:]
        }
        guard total == rxTotal else { return }

        rxParts[sequence] = Data(data.dropFirst(Self.frameHeader))

        guard rxParts.count == total else { return }

        let joined = (0..<total).compactMap { rxParts[$0] }.reduce(Data()) { $0 + $1 }
        rxGeneration = nil
        rxTotal = 0
        rxParts = [:]
        parseStatus(joined)
    }

    private func parseStatus(_ data: Data) {
        do {
            let decoded = try JSONDecoder().decode(PomoStatus.self, from: data)
            status = decoded
            lastStatusAt = Date()
            lastMessage = nil
        } catch {
            lastMessage = "Received an unreadable status update"
        }
    }

    // MARK: Cleanup

    private func clearPeripheral() {
        peripheral?.delegate = nil
        peripheral = nil
        statusCharacteristic = nil
        commandCharacteristic = nil
        frameQueue.removeAll()
        isWriting = false
        rxGeneration = nil
        rxTotal = 0
        rxParts = [:]
    }

    private static func stateText(_ state: CBManagerState) -> String {
        switch state {
        case .poweredOn: return "ready"
        case .poweredOff: return "off"
        case .unauthorized: return "unauthorised"
        case .unsupported: return "unsupported"
        case .preparing: return "starting"
        @unknown default: return "unavailable"
        }
    }
}

// MARK: - CBCentralManagerDelegate

extension PomoBLE: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            if connection == .scanning {
                central.scanForPeripherals(
                    withServices: [Self.serviceUUID],
                    options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
                )
            }
        case .poweredOff:
            scanTimer?.invalidate()
            clearPeripheral()
            connection = .failed("Bluetooth is off")
        case .unauthorized:
            connection = .failed("Bluetooth permission denied")
        case .unsupported:
            connection = .failed("Bluetooth not supported")
        default:
            break
        }
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        scanTimer?.invalidate()
        central.stopScan()

        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String
            ?? peripheral.name
            ?? "espstudy"

        deviceName = name
        connection = .connecting
        self.peripheral = peripheral
        peripheral.delegate = self
        central.connect(peripheral, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral == self.peripheral else { return }
        connection = .discovering
        peripheral.discoverServices([Self.serviceUUID])
    }

    func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        clearPeripheral()
        connection = .failed(error?.localizedDescription ?? "Could not connect")
    }

    func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        guard peripheral == self.peripheral else { return }
        clearPeripheral()
        connection = .failed(error?.localizedDescription ?? "Device disconnected")
    }
}

// MARK: - CBPeripheralDelegate

extension PomoBLE: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error {
            connection = .failed("Service discovery failed: \(error.localizedDescription)")
            return
        }

        guard let service = peripheral.services?.first(where: { $0.uuid == Self.serviceUUID }) else {
            connection = .failed("POMO service not found")
            return
        }

        peripheral.discoverCharacteristics([Self.statusUUID, Self.commandUUID], for: service)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        if let error {
            connection = .failed("Characteristic discovery failed: \(error.localizedDescription)")
            return
        }

        let characteristics = service.characteristics ?? []
        guard let status = characteristics.first(where: { $0.uuid == Self.statusUUID }),
              let command = characteristics.first(where: { $0.uuid == Self.commandUUID }) else {
            connection = .failed("Status or command characteristic missing")
            return
        }

        statusCharacteristic = status
        commandCharacteristic = command

        guard status.properties.contains(.notify) else {
            connection = .failed("Status characteristic cannot notify")
            return
        }

        peripheral.setNotifyValue(true, for: status)
        peripheral.readValue(for: status)
        connection = .connected
        lastMessage = "Connected to \(deviceName ?? "espstudy")"

        // Ask for a fresh notification so the UI is immediately in sync.
        send(.status)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        if let error {
            lastMessage = "Notifications unavailable: \(error.localizedDescription)"
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard characteristic.uuid == Self.statusUUID else { return }
        if let error {
            lastMessage = "Status update failed: \(error.localizedDescription)"
            return
        }
        guard let value = characteristic.value else { return }
        handleIncoming(value)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didWriteValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard characteristic.uuid == Self.commandUUID else { return }
        isWriting = false

        if let error {
            frameQueue.removeAll()
            lastMessage = "Command failed: \(error.localizedDescription)"
            return
        }
        pumpWrites()
    }
}
