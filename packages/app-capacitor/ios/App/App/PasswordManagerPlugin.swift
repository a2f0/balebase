import AuthenticationServices
import Capacitor
import Security

/// Offers to save the password a person just signed in with (savePassword.ts)
/// for the hosted app's domain, which App.entitlements names and that site's
/// apple-app-site-association file confirms. The WebView's AutoFill never
/// offers to: the page is served from capacitor://localhost, and sign-ins go
/// through native HTTP without navigating.
@objc(PasswordManagerPlugin)
public class PasswordManagerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PasswordManagerPlugin"
    public let jsName = "PasswordManager"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise)
    ]

    @objc func save(_ call: CAPPluginCall) {
        guard let domain = call.getString("domain"), !domain.isEmpty,
              let username = call.getString("username"), !username.isEmpty,
              let password = call.getString("password"), !password.isEmpty else {
            call.reject("A domain, username, and password are required.")
            return
        }
        if #available(iOS 26.2, *) {
            Task { @MainActor in
                guard let window = self.bridge?.viewController?.view.window else {
                    call.reject("The app has no window to ask from.")
                    return
                }
                do {
                    try await ASCredentialDataManager().save(
                        password: ASPasswordCredential(user: username, password: password),
                        for: ASAutoFillURLScope(host: domain),
                        anchor: window
                    )
                    call.resolve()
                } catch {
                    call.reject(error.localizedDescription)
                }
            }
        } else {
            // Saves without asking unless the account already has a different
            // saved password.
            SecAddSharedWebCredential(domain as CFString, username as CFString, password as CFString) { error in
                if let error {
                    call.reject(CFErrorCopyDescription(error) as String)
                } else {
                    call.resolve()
                }
            }
        }
    }
}
