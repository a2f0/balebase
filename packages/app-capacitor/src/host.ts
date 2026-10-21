import type { AppHost } from "@balebase/app/host";
import { Capacitor } from "@capacitor/core";
import { saveNativeFile } from "./saveFile";

/**
 * On a device, the WebView's origin marks API requests, emailed links open the
 * hosted app, and downloads go to the share sheet. Served in a desktop browser
 * during development, the shell behaves like the web app.
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
    },
  };
}
