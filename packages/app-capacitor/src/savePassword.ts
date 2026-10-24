import { registerPlugin } from "@capacitor/core";

interface PasswordManagerPlugin {
  save(options: {
    domain: string;
    password: string;
    username: string;
  }): Promise<void>;
}

// The native projects register this plugin themselves: MainActivity on
// Android and MainViewController on iOS.
const passwordManager =
  registerPlugin<PasswordManagerPlugin>("PasswordManager");

/**
 * Saves sign-in credentials with the system password manager. iOS stores them
 * for the hosted app's domain, which the app's webcredentials entitlement names,
 * so Safari and the app share them. The iOS plugin asks before requesting a save
 * and shows failures itself; a resolved request does not confirm storage.
 * Android's Credential Manager asks to save them for the app.
 */
export function nativePasswordSaver(
  appUrl: string,
  plugin: PasswordManagerPlugin = passwordManager,
) {
  const domain = new URL(appUrl).hostname;
  return (username: string, password: string) =>
    plugin.save({ domain, password, username });
}
