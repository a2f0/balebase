import { api } from "../shared/apiClient";
import { prepareOfflineDevice } from "./offlinePreparation";
import {
  changeOfflineWorkspace,
  type OfflineIdentity,
  offlineAccessEpoch,
  offlineScopeKey,
  readOfflineWorkspace,
} from "./offlineStore";

/**
 * Brings this device's copy of the person's projects, their published forms,
 * and the organization's people up to date, so they are here before the
 * device leaves coverage. Resolves whether it stored anything.
 *
 * The device sends the cursor it stored; the server answers `changed: false`
 * when nothing it keeps has changed since, or the whole set with a new
 * cursor. The set and its cursor are stored in one transaction, and only
 * over the cursor this read started from: a newer sync another tab stored
 * meanwhile wins, and this one's answer is dropped. Forms that drop out of
 * the set stay inside the audits started from them, so that work still
 * syncs.
 *
 * `epoch` is the access epoch when the identity was confirmed: signing out
 * or switching accounts meanwhile stops the sync before it unlocks the
 * device for the old identity or stores data for it.
 */
export async function pullOfflineWorkspace(
  identity: OfflineIdentity,
  epoch: string,
) {
  await prepareOfflineDevice(identity, epoch);
  const key = offlineScopeKey(identity.scope);
  return navigator.locks.request(`balebase-pull:${key}`, async () => {
    const from = (await readOfflineWorkspace(key))?.cursor;
    const data = await api.offline.sync(identity.scope, from);
    if (!data.changed) return false;
    let stored = false;
    await changeOfflineWorkspace(key, (current) => {
      if (!current) throw new Error("Offline storage is unavailable.");
      if (epoch !== offlineAccessEpoch())
        throw new Error("The active account changed. Reload before syncing.");
      if (current.cursor !== from) return current;
      current.projects = data.projects;
      current.forms = data.forms;
      current.members = data.members;
      current.cursor = data.cursor;
      stored = true;
      return current;
    });
    return stored;
  });
}
