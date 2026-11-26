import { Balebase } from "@balebase/client-sdk";
import { type AppHost, appHost } from "./host";
import { apiUrl } from "./shared/config";

let built: { host: AppHost; sdk: Balebase } | undefined;

/**
 * The app's SDK: the API and the client state behind it, made from the host
 * `configureHost` set, so the two never disagree. Until a shell configures
 * one, as in tests, it is a browser's.
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
      }),
    };
  }
  return built.sdk;
}
