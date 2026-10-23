import Capacitor

/// Registers the plugins that live in this target rather than in a package.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PasswordManagerPlugin())
    }
}
