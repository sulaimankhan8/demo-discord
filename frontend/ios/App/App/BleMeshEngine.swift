import CoreBluetooth
import Foundation

/// Events from the engine to the plugin.
protocol BleMeshEngineDelegate: AnyObject {
    func meshLinkUp(_ linkId: String, maxFrameBytes: Int, role: String)
    func meshLinkDown(_ linkId: String)
    func meshData(_ linkId: String, _ data: Data)
    func meshStateChanged()
}

/// BLE link layer for the offline mesh: the iOS twin of BleMeshEngine.java. Each phone
/// advertises a GATT service (so others can find it) and scans for the same service (so it can
/// connect to others), at the same time. It only finds phones, keeps links open and moves raw
/// frames; all mesh logic lives in the web code (frontend/lib/mesh).
///
/// Works with Android phones running the same app:
/// - Same service and characteristic UUIDs.
/// - Duplicate links: the phone with the lower 8-byte node id connects; the other waits and
///   connects anyway after 15 s. Android puts its node id in service data; iOS can't advertise
///   service data, so it puts "M" + the id in hex in the local name. Both sides read both.
/// - After connecting, the central sends a hello frame [0xFF][node id]. Mesh frames always start
///   with 0x00 or 0x01, so the hello never reaches the mesh code.
///
/// Everything runs on the main queue.
final class BleMeshEngine: NSObject {

    static let defaultServiceUUID = CBUUID(string: "F47B5E2D-4A9E-4C5B-9E1A-3B2C8D7E6F01")
    static let defaultCharacteristicUUID = CBUUID(string: "F47B5E2D-4A9E-4C5B-9E1A-3B2C8D7E6F02")

    private static let hello: UInt8 = 0xFF
    private static let nodeIdBytes = 8
    private static let maxQueue = 512
    private static let maxAttributeBytes = 512
    private static let connectTimeout: TimeInterval = 12
    private static let retryCooldown: TimeInterval = 10
    private static let fallbackConnect: TimeInterval = 15

    private final class Link {
        let id: String
        let role: String // "central" (we connected) or "peripheral" (they connected to us)
        var peripheral: CBPeripheral? // set for central links (must be kept alive)
        var central: CBCentral? // set for peripheral links
        var characteristic: CBCharacteristic?
        var nodeId: Data?
        var maxFrameBytes = 20
        var up = false
        var queue: [Data] = []
        var connectTimer: DispatchWorkItem?

        init(id: String, role: String) {
            self.id = id
            self.role = role
        }
    }

    weak var delegate: BleMeshEngineDelegate?

    private(set) var running = false
    private(set) var advertising = false
    private(set) var scanning = false
    private(set) var lastError: String?

    private var centralManager: CBCentralManager?
    private var peripheralManager: CBPeripheralManager?
    private var serverCharacteristic: CBMutableCharacteristic?
    private var serviceAdded = false

    private var serviceUUID = BleMeshEngine.defaultServiceUUID
    private var characteristicUUID = BleMeshEngine.defaultCharacteristicUUID
    private var maxLinks = 7
    private var nodeId = Data()

    private var links: [String: Link] = [:]
    private var cooldownUntil: [UUID: Date] = [:]
    private var firstSeen: [UUID: Date] = [:]
    private var pendingPeripheral: UUID?

    private var permissionWaiters: [(Bool) -> Void] = []
    private var pendingStart: ((String?) -> Void)?

    // MARK: - Managers and permission

    /// Creating the managers shows iOS's Bluetooth permission prompt the first time.
    private func createManagersIfNeeded() {
        if centralManager == nil {
            centralManager = CBCentralManager(delegate: self, queue: nil)
        }
        if peripheralManager == nil {
            peripheralManager = CBPeripheralManager(delegate: self, queue: nil)
        }
    }

    var bluetoothOn: Bool {
        return centralManager?.state == .poweredOn
    }

    func ensurePermissions(_ done: @escaping (Bool) -> Void) {
        switch CBManager.authorization {
        case .allowedAlways:
            done(true)
        case .notDetermined:
            permissionWaiters.append(done)
            createManagersIfNeeded() // the answer arrives in centralManagerDidUpdateState
        default:
            done(false)
        }
    }

    private func resolvePermissionWaiters() {
        guard CBManager.authorization != .notDetermined, !permissionWaiters.isEmpty else { return }
        let granted = CBManager.authorization == .allowedAlways
        let waiters = permissionWaiters
        permissionWaiters = []
        waiters.forEach { $0(granted) }
    }

    // MARK: - Lifecycle

    /// Starts the mesh radio. Calls back with nil on success, or an error code.
    func start(service: CBUUID, characteristic: CBUUID, maxLinks: Int, completion: @escaping (String?) -> Void) {
        if running {
            completion(nil)
            return
        }
        serviceUUID = service
        characteristicUUID = characteristic
        self.maxLinks = max(1, maxLinks)
        createManagersIfNeeded()
        pendingStart = completion
        evaluatePendingStart()
    }

    private func evaluatePendingStart() {
        guard let completion = pendingStart, let central = centralManager else { return }
        switch central.state {
        case .unknown, .resetting:
            return // wait for centralManagerDidUpdateState
        case .unsupported:
            pendingStart = nil
            completion("UNSUPPORTED")
        case .unauthorized:
            pendingStart = nil
            completion("PERMISSION")
        case .poweredOff:
            pendingStart = nil
            completion("BLUETOOTH_OFF")
        case .poweredOn:
            pendingStart = nil
            var id = Data(count: BleMeshEngine.nodeIdBytes)
            id.withUnsafeMutableBytes { buf in
                for i in 0..<buf.count { buf[i] = UInt8.random(in: 0...255) }
            }
            nodeId = id
            running = true
            lastError = nil
            startScanIfReady()
            addServiceIfReady()
            delegate?.meshStateChanged()
            completion(nil)
        @unknown default:
            pendingStart = nil
            completion("UNSUPPORTED")
        }
    }

    func stop() {
        guard running else { return }
        running = false
        if scanning { centralManager?.stopScan() }
        scanning = false
        if advertising { peripheralManager?.stopAdvertising() }
        advertising = false
        peripheralManager?.removeAllServices()
        serviceAdded = false
        serverCharacteristic = nil
        for link in Array(links.values) { removeLink(link) }
        pendingPeripheral = nil
        cooldownUntil.removeAll()
        firstSeen.removeAll()
        delegate?.meshStateChanged()
    }

    private func setError(_ message: String) {
        lastError = message
        NSLog("[BleMesh] %@", message)
        delegate?.meshStateChanged()
    }

    // MARK: - State for the plugin

    func describeLinks() -> [[String: Any]] {
        return links.values.filter { $0.up }.map { link -> [String: Any] in
            ["linkId": link.id, "role": link.role, "maxFrameBytes": link.maxFrameBytes]
        }
    }

    private var upLinkCount: Int {
        return links.values.filter { $0.up }.count
    }

    // MARK: - Sending

    /// Queues a frame for a link. Returns false if the link is gone or its queue is full.
    func send(_ linkId: String, _ frame: Data) -> Bool {
        guard let link = links[linkId], link.up, !frame.isEmpty, frame.count <= link.maxFrameBytes else { return false }
        guard link.queue.count < BleMeshEngine.maxQueue else { return false }
        link.queue.append(frame)
        pump(link)
        return true
    }

    /// Sends queued frames until iOS says its buffer is full; it calls us back when there's room.
    private func pump(_ link: Link) {
        guard link.up else { return }
        if link.role == "central" {
            guard let p = link.peripheral, let ch = link.characteristic else { return }
            while !link.queue.isEmpty && p.canSendWriteWithoutResponse {
                p.writeValue(link.queue.removeFirst(), for: ch, type: .withoutResponse)
            }
        } else {
            guard let pm = peripheralManager, let ch = serverCharacteristic, let c = link.central else { return }
            while let next = link.queue.first {
                if pm.updateValue(next, for: ch, onSubscribedCentrals: [c]) {
                    link.queue.removeFirst()
                } else {
                    break // peripheralManagerIsReady(toUpdateSubscribers:) will call pump again
                }
            }
        }
    }

    // MARK: - Links

    private func failLink(_ link: Link) {
        if !link.up, let p = link.peripheral {
            cooldownUntil[p.identifier] = Date().addingTimeInterval(BleMeshEngine.retryCooldown)
        }
        removeLink(link)
    }

    private func removeLink(_ link: Link) {
        guard links[link.id] === link else { return }
        links[link.id] = nil
        link.connectTimer?.cancel()
        if let p = link.peripheral {
            if pendingPeripheral == p.identifier { pendingPeripheral = nil }
            centralManager?.cancelPeripheralConnection(p)
        }
        link.queue.removeAll()
        if link.up {
            link.up = false
            delegate?.meshLinkDown(link.id)
            delegate?.meshStateChanged()
        }
    }

    private func isLinked(to peerId: Data) -> Bool {
        return links.values.contains { $0.up && $0.nodeId == peerId }
    }

    private static func compare(_ a: Data, _ b: Data) -> Int {
        for (x, y) in zip(a, b) where x != y {
            return x < y ? -1 : 1
        }
        return a.count - b.count
    }

    private static func hex(_ data: Data) -> String {
        return data.map { String(format: "%02x", $0) }.joined()
    }

    private static func dataFromHex(_ hex: String) -> Data? {
        guard hex.count % 2 == 0 else { return nil }
        var out = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            out.append(byte)
            index = next
        }
        return out
    }

    /// Reads a phone's node id: service data (Android) or "M<hex>" local name (iOS).
    private func peerNodeId(from ad: [String: Any]) -> Data? {
        if let serviceData = ad[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data],
           let id = serviceData[serviceUUID], id.count == BleMeshEngine.nodeIdBytes {
            return id
        }
        if let name = ad[CBAdvertisementDataLocalNameKey] as? String,
           name.count == 1 + BleMeshEngine.nodeIdBytes * 2, name.hasPrefix("M"),
           let id = BleMeshEngine.dataFromHex(String(name.dropFirst())) {
            return id
        }
        return nil
    }

    // MARK: - Peripheral role (GATT server + advertising)

    private func addServiceIfReady() {
        guard running, !serviceAdded, let pm = peripheralManager, pm.state == .poweredOn else { return }
        let ch = CBMutableCharacteristic(
            type: characteristicUUID,
            properties: [.write, .writeWithoutResponse, .notify],
            value: nil,
            permissions: [.writeable]
        )
        let service = CBMutableService(type: serviceUUID, primary: true)
        service.characteristics = [ch]
        serverCharacteristic = ch
        serviceAdded = true
        pm.add(service) // advertising starts in didAdd
    }

    private func startAdvertising() {
        guard running, let pm = peripheralManager, pm.state == .poweredOn, !pm.isAdvertising else { return }
        pm.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [serviceUUID],
            CBAdvertisementDataLocalNameKey: "M" + BleMeshEngine.hex(nodeId),
        ])
    }

    private func peripheralLink(for central: CBCentral) -> Link {
        let id = "p:" + central.identifier.uuidString
        if let link = links[id] { return link }
        let link = Link(id: id, role: "peripheral")
        link.central = central
        links[id] = link
        return link
    }

    // MARK: - Central role (scanning + connecting)

    private func startScanIfReady() {
        guard running, !scanning, let cm = centralManager, cm.state == .poweredOn else { return }
        // Duplicates on, so we keep seeing phones we're waiting on (the 15 s fallback needs it).
        cm.scanForPeripherals(withServices: [serviceUUID], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        scanning = true
    }

    private func connect(_ peripheral: CBPeripheral, peerId: Data?) {
        guard let cm = centralManager else { return }
        let link = Link(id: "c:" + peripheral.identifier.uuidString, role: "central")
        link.peripheral = peripheral
        link.nodeId = peerId
        links[link.id] = link
        pendingPeripheral = peripheral.identifier
        firstSeen[peripheral.identifier] = nil

        peripheral.delegate = self
        cm.connect(peripheral, options: nil)

        let timer = DispatchWorkItem { [weak self, weak link] in
            guard let self = self, let link = link, !link.up else { return }
            self.failLink(link)
        }
        link.connectTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + BleMeshEngine.connectTimeout, execute: timer)
    }

    private func centralLink(_ peripheral: CBPeripheral) -> Link? {
        let link = links["c:" + peripheral.identifier.uuidString]
        return link?.peripheral === peripheral ? link : nil
    }
}

// MARK: - CBCentralManagerDelegate

extension BleMeshEngine: CBCentralManagerDelegate {

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        resolvePermissionWaiters()
        evaluatePendingStart()
        guard running else { return }
        if central.state == .poweredOn {
            lastError = nil
            startScanIfReady()
        } else {
            // Bluetooth went off: iOS drops every connection.
            scanning = false
            for link in Array(links.values) where link.role == "central" { removeLink(link) }
            pendingPeripheral = nil
        }
        delegate?.meshStateChanged()
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard running, pendingPeripheral == nil else { return }
        let pid = peripheral.identifier
        if links["c:" + pid.uuidString] != nil { return }
        if upLinkCount >= maxLinks { return }
        let now = Date()
        if let until = cooldownUntil[pid], until > now { return }

        let peerId = peerNodeId(from: advertisementData)
        if let peerId = peerId {
            if peerId == nodeId { return }
            if isLinked(to: peerId) { return } // they already connected to us
            if BleMeshEngine.compare(nodeId, peerId) > 0 {
                // The other phone has the lower id and should connect to us. Connect anyway if
                // it still hasn't after a while (it may not be able to see us).
                guard let first = firstSeen[pid] else {
                    firstSeen[pid] = now
                    return
                }
                if now.timeIntervalSince(first) < BleMeshEngine.fallbackConnect { return }
            }
        }
        connect(peripheral, peerId: peerId)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard centralLink(peripheral) != nil else {
            central.cancelPeripheralConnection(peripheral)
            return
        }
        peripheral.discoverServices([serviceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        if let link = centralLink(peripheral) { failLink(link) }
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        if let link = centralLink(peripheral) { failLink(link) }
    }
}

// MARK: - CBPeripheralDelegate (we are the central)

extension BleMeshEngine: CBPeripheralDelegate {

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let link = centralLink(peripheral) else { return }
        guard error == nil, let service = peripheral.services?.first(where: { $0.uuid == serviceUUID }) else {
            failLink(link)
            return
        }
        peripheral.discoverCharacteristics([characteristicUUID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let link = centralLink(peripheral) else { return }
        guard error == nil, let ch = service.characteristics?.first(where: { $0.uuid == characteristicUUID }) else {
            failLink(link)
            return
        }
        link.characteristic = ch
        peripheral.setNotifyValue(true, for: ch)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard let link = centralLink(peripheral), !link.up else { return }
        guard error == nil, characteristic.isNotifying else {
            failLink(link)
            return
        }
        link.connectTimer?.cancel()
        if pendingPeripheral == peripheral.identifier { pendingPeripheral = nil }
        if upLinkCount >= maxLinks {
            removeLink(link)
            return
        }
        link.maxFrameBytes = max(20, min(peripheral.maximumWriteValueLength(for: .withoutResponse), BleMeshEngine.maxAttributeBytes))
        link.up = true
        var helloFrame = Data([BleMeshEngine.hello])
        helloFrame.append(nodeId)
        link.queue.insert(helloFrame, at: 0)
        delegate?.meshLinkUp(link.id, maxFrameBytes: link.maxFrameBytes, role: link.role)
        delegate?.meshStateChanged()
        pump(link)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, let link = centralLink(peripheral), link.up,
              let value = characteristic.value, !value.isEmpty else { return }
        delegate?.meshData(link.id, value)
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        if let link = centralLink(peripheral) { pump(link) }
    }
}

// MARK: - CBPeripheralManagerDelegate (we are the peripheral)

extension BleMeshEngine: CBPeripheralManagerDelegate {

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        resolvePermissionWaiters()
        guard running else { return }
        if peripheral.state == .poweredOn {
            addServiceIfReady()
        } else {
            // Bluetooth went off: iOS removes our service and drops subscribers.
            advertising = false
            serviceAdded = false
            serverCharacteristic = nil
            for link in Array(links.values) where link.role == "peripheral" { removeLink(link) }
        }
        delegate?.meshStateChanged()
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error = error {
            serviceAdded = false
            setError("Couldn't register the mesh Bluetooth service: \(error.localizedDescription)")
            return
        }
        startAdvertising()
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        advertising = error == nil
        if let error = error {
            setError("Bluetooth advertising failed: \(error.localizedDescription). Other phones may not find this one.")
        } else {
            delegate?.meshStateChanged()
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        guard running else { return }
        let link = peripheralLink(for: central)
        if link.up { return }
        if upLinkCount >= maxLinks { return } // iOS can't refuse a central; just don't use this link
        link.maxFrameBytes = max(20, min(central.maximumUpdateValueLength, BleMeshEngine.maxAttributeBytes))
        link.up = true
        delegate?.meshLinkUp(link.id, maxFrameBytes: link.maxFrameBytes, role: link.role)
        delegate?.meshStateChanged()
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        if let link = links["p:" + central.identifier.uuidString] { removeLink(link) }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for request in requests where request.characteristic.uuid == characteristicUUID {
            guard let value = request.value, !value.isEmpty,
                  let link = links["p:" + request.central.identifier.uuidString], link.up else { continue }
            if value.first == BleMeshEngine.hello && value.count == 1 + BleMeshEngine.nodeIdBytes {
                link.nodeId = value.subdata(in: 1..<value.count)
                continue
            }
            delegate?.meshData(link.id, value)
        }
        if let first = requests.first {
            peripheral.respond(to: first, withResult: .success)
        }
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        for link in links.values where link.role == "peripheral" && link.up {
            pump(link)
        }
    }
}
