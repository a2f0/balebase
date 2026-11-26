import { Balebase } from "@balebase/client-sdk";
import { type AppHost, configureHost } from "./host";
import { apiUrl } from "./shared/config";

function create(host: AppHost) {
  return new Balebase({
    apiBaseUrl: apiUrl,
    nativeOrigin: host.native?.origin,
    network: host.network,
  });
}

let current = create({});

/**
 * The app's SDK: the API and the client state behind it. Until
 * `startBalebase` runs it is a browser's, which is what tests use.
 */
export function balebase() {
  return current;
}

/**
 * Configures the shell's host and makes the SDK from it, so the two never
 * disagree. `renderApp` calls it before the first render, so no screen holds
 * the browser's.
 */
export function startBalebase(host: AppHost) {
  configureHost(host);
  current = create(host);
}
