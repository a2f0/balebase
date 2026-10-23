import type { SavedSignIn } from "@balebase/app/host";
import { registerPlugin } from "@capacitor/core";

interface PasswordManagerPlugin {
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

export async function chooseNativeSavedSignIn() {
  try {
    return (await passwordManager.choose()).credential;
  } catch {
    throw new Error(
      "Couldn’t open saved sign-ins. You can still enter your email and password.",
    );
  }
}
