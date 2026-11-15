import type { SavedSignIn } from "@balebase/app/host";
import { registerPlugin } from "@capacitor/core";

interface PasswordManagerPlugin {
  /** Android only; resolves without a credential when none is chosen. */
  choose(): Promise<{ credential?: SavedSignIn }>;
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
  plugin: Pick<PasswordManagerPlugin, "save"> = passwordManager,
) {
  const domain = new URL(appUrl).hostname;
  return (username: string, password: string) =>
    plugin.save({ domain, password, username });
}

/**
 * Offers the passwords Android's Credential Manager saved for the app, which
 * the WebView's autofill does not suggest. iOS keyboard AutoFill already offers
 * them through the webcredentials association.
 */
export async function chooseNativeSavedSignIn(
  plugin: Pick<PasswordManagerPlugin, "choose"> = passwordManager,
) {
  return (await plugin.choose()).credential;
}
