import { api } from "../shared/apiClient";
import { prepareOfflineDevice } from "./offlinePreparation";
import {
  activateOfflineWorkspace,
  changeOfflineWorkspace,
  type OfflineIdentity,
  offlineScopeKey,
} from "./offlineStore";
import { offlineDownloadState } from "./offlineWork";

/**
 * Downloads the audit forms turned on for the person's projects, and any
 * newer versions of them, so they are on the device before leaving
 * coverage. Forms already current stay as they are, and forms downloaded by
 * hand are kept. Resolves how many forms it saved.
 *
 * `epoch` is the access epoch when the identity was confirmed: signing out
 * or switching accounts meanwhile stops the download before it unlocks the
 * device for the old identity.
 */
export async function hydrateProjectForms(
  identity: OfflineIdentity,
  epoch: string,
) {
  const data = await api.offline.forms(identity.scope);
  const wanted = data.templates.filter((template) =>
    data.projectFormIds.includes(template.id),
  );
  if (!wanted.length) return 0;
  await prepareOfflineDevice(identity, epoch);
  const key = offlineScopeKey(identity.scope);
  let saved = 0;
  await changeOfflineWorkspace(key, (current) => {
    if (!current) throw new Error("Offline storage is unavailable.");
    saved = 0;
    for (const template of wanted) {
      if (offlineDownloadState(current.templates, template) === "current")
        continue;
      current.templates = [
        ...current.templates.filter((entry) => entry.id !== template.id),
        template,
      ];
      saved += 1;
    }
    current.members = data.members;
    return current;
  });
  activateOfflineWorkspace(key, epoch);
  await navigator.storage?.persist?.().catch(() => false);
  return saved;
}
