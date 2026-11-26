import { Balebase } from "@balebase/client-sdk";
import { type AppHost, appHost } from "./host";
import { waitForOfflineShell } from "./offline/offlineShell";
import { apiUrl } from "./shared/config";

let built: { host: AppHost; sdk: Balebase } | undefined;

/**
 * The app's SDK: the API and the client state behind it, made from the host
 * `configureHost` set, so the two never disagree. Until a shell configures
 * one, as in tests, it is a browser's. `renderApp` configures the host once;
 * only tests change it again, which starts a new SDK with no recorded state.
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
        // A native shell always reopens; a web build does once its service
        // worker controls it, which development builds never register.
        waitForOfflineShell:
          !host.native && import.meta.env.PROD
            ? waitForOfflineShell
            : undefined,
      }),
    };
  }
  return built.sdk;
}
