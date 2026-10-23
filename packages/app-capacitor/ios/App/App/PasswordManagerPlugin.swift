import AuthenticationServices
import Capacitor
import Security
import UIKit

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
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "choose", returnType: CAPPluginReturnPromise)
    ]
    @MainActor private var saveInProgress = false
    @MainActor private var signInRequest: SavedSignInRequest?

    @objc func choose(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard self.signInRequest == nil, !self.saveInProgress else {
                call.reject("A password manager request is already in progress.")
                return
            }
            guard let presenter = self.bridge?.viewController,
                  let window = presenter.view.window,
                  presenter.presentedViewController == nil else {
                call.reject("The app has no available window to ask from.")
                return
            }
            presenter.view.endEditing(true)
            let request = SavedSignInRequest(window: window, call: call) { [weak self] in
                self?.signInRequest = nil
            }
            self.signInRequest = request
            request.start()
        }
    }

    @objc func save(_ call: CAPPluginCall) {
        guard let domain = call.getString("domain"), !domain.isEmpty,
              let username = call.getString("username"), !username.isEmpty,
              let password = call.getString("password"), !password.isEmpty else {
            call.reject("A domain, username, and password are required.")
            return
        }
        Task { @MainActor in
            guard !self.saveInProgress, self.signInRequest == nil else {
                call.reject("A password manager request is already in progress.")
                return
            }
            guard let presenter = self.bridge?.viewController,
                  let window = presenter.view.window,
                  presenter.presentedViewController == nil else {
                call.reject("The app has no available window to ask from.")
                return
            }
            self.offerSave(domain: domain, username: username, password: password, from: presenter, window: window)
            // Acknowledge the offer, not storage. Its actions own the save and
            // error UI; dismissing the offer can never strand a bridge call.
            call.resolve()
        }
    }

    @MainActor
    private func offerSave(domain: String, username: String, password: String,
                           from presenter: UIViewController, window: UIWindow) {
        // ASCredentialDataManager does not guarantee a visible system prompt.
        // Ask explicitly, including on older iOS where the legacy API can save silently.
        presenter.view.endEditing(true)
        let alert = UIAlertController(
            title: "Save password?",
            message: "Save your email and password for \(domain) to your password manager?",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Not now", style: .cancel))
        alert.addAction(UIAlertAction(title: "Save password", style: .default) { [weak self, weak presenter] _ in
            Task { @MainActor in
                guard let self, let presenter else { return }
                self.saveInProgress = true
                defer { self.saveInProgress = false }
                do {
                    try await self.storePassword(domain: domain, username: username, password: password, window: window)
                    // The system acknowledges a request, not whether it stored
                    // the password. Never show a "saved" confirmation.
                } catch let error as ASAuthorizationError where error.code == .canceled {
                    return
                } catch {
                    let failure = error as NSError
                    // Keep credentials and the possibly sensitive error description out of logs.
                    NSLog("Password save failed (%@, %ld).", failure.domain, failure.code)
                    self.showSaveFailure(from: presenter)
                }
            }
        })
        presenter.present(alert, animated: true)
    }

    @MainActor
    private func storePassword(domain: String, username: String, password: String, window: UIWindow) async throws {
        if #available(iOS 26.2, *) {
            try await ASCredentialDataManager().save(
                password: ASPasswordCredential(user: username, password: password),
                for: ASAutoFillURLScope(host: domain),
                anchor: window
            )
        } else {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                SecAddSharedWebCredential(domain as CFString, username as CFString, password as CFString) { error in
                    if let error {
                        // Dismissing the system's own confirmation is not a save failure.
                        if CFErrorGetCode(error) == errSecUserCanceled {
                            continuation.resume()
                        } else {
                            continuation.resume(throwing: error)
                        }
                    } else {
                        continuation.resume()
                    }
                }
            }
        }
    }

    @MainActor
    private func showSaveFailure(from presenter: UIViewController) {
        let alert = UIAlertController(
            title: "Password couldn’t be saved",
            message: "Check that password AutoFill and a password manager are enabled in Settings, then try signing in again. You’re still signed in.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        presenter.present(alert, animated: true)
    }
}

/// The system scopes this request to the app's associated webcredentials
/// domain. It returns the selected account's username and password together.
@MainActor
private final class SavedSignInRequest: NSObject, ASAuthorizationControllerDelegate,
                                        ASAuthorizationControllerPresentationContextProviding {
    private let window: UIWindow
    private let call: CAPPluginCall
    private let onFinish: () -> Void

    init(window: UIWindow, call: CAPPluginCall, onFinish: @escaping () -> Void) {
        self.window = window
        self.call = call
        self.onFinish = onFinish
    }

    func start() {
        let controller = ASAuthorizationController(authorizationRequests: [ASAuthorizationPasswordProvider().createRequest()])
        controller.delegate = self
        controller.presentationContextProvider = self
        // The controller retains itself until it calls its delegate. The plugin
        // retains this request (the controller's delegate references are weak).
        controller.performRequests()
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        window
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        defer { onFinish() }
        guard let credential = authorization.credential as? ASPasswordCredential else {
            call.reject("No saved password was selected.")
            return
        }
        call.resolve(["credential": ["username": credential.user, "password": credential.password]])
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        defer { onFinish() }
        if let error = error as? ASAuthorizationError, error.code == .canceled {
            call.resolve()
        } else {
            // Never put the credential or the system error's description in logs.
            call.reject("Saved sign-ins are unavailable.")
        }
    }
}
