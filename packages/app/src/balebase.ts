import { Balebase } from "@balebase/client-sdk";
import { type AppHost, appHost } from "./host";
import { waitForOfflineShell } from "./offline/offlineShell";
import { apiUrl } from "./shared/config";

let built: { host: AppHost; sdk: Balebase } | undefined;

/**
 * What preparing offline work waits for on `host`. A native shell always
 * reopens; a web build does once its service worker is active, which
 * development builds never register.
 */
export function offlineShellWait(
  host: AppHost,
  production: boolean = import.meta.env.PROD,
) {
  return !host.native && production ? waitForOfflineShell : undefined;
}

/**
 * The app's SDK: the API and the client state behind it, made from the host
 * `configureHost` set, so the two never disagree. Until a shell configures
 * one, as in tests, it is a browser's. `renderApp` configures the host once;
 * only tests change it again, which starts a new SDK with no recorded API
 * version and a new auth client with no session yet (the old one keeps
 * watching the session until the page goes). Offline locks and the tab's
 * change and clearing subscribers carry over.
 */
export function balebase() {
  const host = appHost();
  if (built?.host !== host) {
    built = {
      host,
      sdk: new Balebase({
        apiBaseUrl: apiUrl,
        nativeOrigin: host.native?.origin,
        network: host.network,
        waitForOfflineShell: offlineShellWait(host),
      }),
    };
  }
  return built.sdk;
}
