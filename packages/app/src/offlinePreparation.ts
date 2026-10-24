import { nativeHost } from "./host";
import type { OfflineIdentity } from "./OfflineWorkspacePage";
import {
  activateOfflineWorkspace,
  changeOfflineWorkspace,
  offlineScopeKey,
} from "./offlineStore";

export async function prepareOfflineDevice(
  identity: OfflineIdentity,
  epoch: string,
) {
  if (!navigator.locks)
    throw new Error(
      "This browser cannot safely sync offline work. Update your browser and try again.",
    );
  if (!nativeHost() && import.meta.env.PROD) await waitForOfflineShell();
  const key = offlineScopeKey(identity.scope);
  await changeOfflineWorkspace(
    key,
    (current) =>
      current ?? {
        ...identity,
        key,
        templates: [],
        members: [],
        audits: [],
        issues: [],
        jobs: [],
      },
  );
  activateOfflineWorkspace(key, epoch);
}

function waitForOfflineShell() {
  if (!("serviceWorker" in navigator))
    throw new Error(
      "Offline reopening requires a supported browser with service workers enabled.",
    );
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(
      () =>
        reject(
          new Error(
            "The app is still downloading for offline use. Stay connected and try again.",
          ),
        ),
      15_000,
    );
    void navigator.serviceWorker.ready.then(
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      (cause: unknown) => {
        window.clearTimeout(timer);
        reject(cause);
      },
    );
  });
}
