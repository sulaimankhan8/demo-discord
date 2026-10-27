import Capacitor
import CoreBluetooth
import UIKit

/// Capacitor bridge for the offline mesh's Bluetooth link layer: the iOS twin of
/// BleMeshPlugin.java, with the same JavaScript API (frontend/lib/mesh/transports/BleLinkTransport.ts).
/// Frames cross the bridge as base64.
@objc(BleMeshPlugin)
public class BleMeshPlugin: CAPPlugin, CAPBridgedPlugin, BleMeshEngineDelegate {
    public let identifier = "BleMeshPlugin"
    public let jsName = "BleMesh"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "ensurePermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enableBluetooth", returnType: CAPPluginReturnPromise),
    ]

    private let engine = BleMeshEngine()

    override public func load() {
        engine.delegate = self
    }

    // MARK: - Permissions

    @objc func ensurePermissions(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.engine.ensurePermissions { granted in
                call.resolve(["granted": granted])
            }
        }
    }

    // MARK: - Lifecycle

    @objc func start(_ call: CAPPluginCall) {
        guard let service = Self.uuid(call.getString("serviceUuid"), fallback: BleMeshEngine.defaultServiceUUID),
              let characteristic = Self.uuid(call.getString("characteristicUuid"), fallback: BleMeshEngine.defaultCharacteristicUUID) else {
            call.reject("Invalid service UUID.", "BAD_ARGUMENT")
            return
        }
        let maxLinks = call.getInt("maxLinks") ?? 7
        DispatchQueue.main.async {
            self.engine.start(service: service, characteristic: characteristic, maxLinks: maxLinks) { error in
                switch error {
                case nil:
                    call.resolve()
                case "BLUETOOTH_OFF"?:
                    call.reject("Bluetooth is off.", "BLUETOOTH_OFF")
                case "PERMISSION"?:
                    call.reject("Bluetooth permission wasn't granted.", "PERMISSION")
                case "UNSUPPORTED"?:
                    call.reject("This device doesn't support Bluetooth Low Energy.", "UNSUPPORTED")
                case let code?:
                    call.reject(code, code)
                }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.engine.stop()
            call.resolve()
        }
    }

    // MARK: - Data

    @objc func send(_ call: CAPPluginCall) {
        guard let linkId = call.getString("linkId"), let base64 = call.getString("data") else {
            call.reject("linkId and data are required.", "BAD_ARGUMENT")
            return
        }
        guard let frame = Data(base64Encoded: base64) else {
            call.reject("data must be base64.", "BAD_ARGUMENT")
            return
        }
        DispatchQueue.main.async {
            call.resolve(["queued": self.engine.send(linkId, frame)])
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(self.stateObject())
        }
    }

    /// iOS doesn't let apps turn Bluetooth on, so this opens the app's page in Settings.
    @objc func enableBluetooth(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
            call.resolve()
        }
    }

    private func stateObject() -> [String: Any] {
        var state: [String: Any] = [
            "running": engine.running,
            "bluetoothOn": engine.bluetoothOn,
            "advertising": engine.advertising,
            "scanning": engine.scanning,
            "links": engine.describeLinks(),
        ]
        if let error = engine.lastError { state["error"] = error }
        return state
    }

    private static func uuid(_ value: String?, fallback: CBUUID) -> CBUUID? {
        guard let value = value else { return fallback }
        guard let parsed = UUID(uuidString: value) else { return nil }
        return CBUUID(nsuuid: parsed)
    }

    // MARK: - Engine events → web

    func meshLinkUp(_ linkId: String, maxFrameBytes: Int, role: String) {
        notifyListeners("linkUp", data: ["linkId": linkId, "maxFrameBytes": maxFrameBytes, "role": role])
    }

    func meshLinkDown(_ linkId: String) {
        notifyListeners("linkDown", data: ["linkId": linkId])
    }

    func meshData(_ linkId: String, _ data: Data) {
        notifyListeners("data", data: ["linkId": linkId, "data": data.base64EncodedString()])
    }

    func meshStateChanged() {
        notifyListeners("state", data: stateObject())
    }
}
