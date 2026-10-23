import type { AppHost } from "@balebase/app/host";
import { Capacitor } from "@capacitor/core";
import { saveNativeFile } from "./saveFile";
import { chooseNativeSavedSignIn, nativePasswordSaver } from "./savePassword";

/**
 * On a device, the WebView's origin marks API requests, emailed links open the
 * hosted app, downloads go to the share sheet, and sign-ins offer to save the
 * password. Served in a desktop browser during development, the shell behaves
 * like the web app.
 */
export function capacitorHost(appUrl: string): AppHost {
  if (!Capacitor.isNativePlatform()) return {};
  return {
    native: {
      appUrl,
      origin:
        Capacitor.getPlatform() === "ios"
          ? "capacitor://localhost"
          : "https://localhost",
      saveFile: saveNativeFile,
      savePassword: nativePasswordSaver(appUrl),
      chooseSavedSignIn:
        Capacitor.getPlatform() === "ios" ? chooseNativeSavedSignIn : undefined,
    },
  };
}
