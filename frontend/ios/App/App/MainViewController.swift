import Capacitor
import UIKit

/// The app's main screen. Same as Capacitor's default, plus our local BleMesh plugin
/// (local plugins have to be registered by hand).
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(BleMeshPlugin())
    }
}
