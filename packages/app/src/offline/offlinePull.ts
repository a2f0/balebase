import { ApiError } from "@balebase/api-client";
import type { OfflineFormState } from "@balebase/validators/offline";
import { api } from "../shared/apiClient";
import { formWrites } from "./offlineFormState";
import { prepareOfflineDevice } from "./offlinePreparation";
import {
  changeOfflineWorkspace,
  type OfflineIdentity,
  offlineAccessEpoch,
  offlineScopeKey,
  readOfflineWorkspace,
} from "./offlineStore";
import { applyOfflineFormEvent } from "./offlineWork";

/**
 * Brings this device's copy of the person's projects, their published templates,
 * and the organization's people up to date, so they are here before the
 * device leaves coverage. Resolves whether it stored anything.
 *
 * The device sends the cursor it stored; the server answers `changed: false`
 * when nothing it keeps has changed since, or the whole set with a new
 * cursor. The set and its cursor are stored in one transaction, and only
 * over the cursor this read started from: a newer sync another tab stored
 * meanwhile wins, and this one's answer is dropped. Templates that drop out of
 * the set stay inside the forms started from them, so that work still
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
      current.templates = data.templates;
      current.members = data.members;
      current.cursor = data.cursor;
      stored = true;
      return current;
    });
    return stored;
  });
}

/**
 * Brings this device's shared forms, in progress or completed, up to date
 * with the server's copies, so answers given elsewhere, a completion made
 * elsewhere, and a reopening made online show here. Each copy is merged in
 * its own transaction and only when newer than the one held
 * (`offlineFormState.ts`), so a write's confirmation that landed meanwhile
 * is never undone. A form gone from the server is left as it is; its next
 * write says why.
 */
export async function pullOfflineForms(
  identity: OfflineIdentity,
  epoch: string,
) {
  const key = offlineScopeKey(identity.scope);
  const workspace = await readOfflineWorkspace(key);
  if (!workspace) return;
  for (const form of workspace.forms) {
    if (formWrites(workspace.jobs, form.id)[0]?.status !== "synced") continue;
    let state: OfflineFormState;
    try {
      state = await api.offline.form(identity.scope, form.id);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) continue;
      throw cause;
    }
    await changeOfflineWorkspace(key, (current) => {
      if (!current) throw new Error("Offline storage is unavailable.");
      if (epoch !== offlineAccessEpoch())
        throw new Error("The active account changed. Reload before syncing.");
      return current.forms.some((entry) => entry.id === form.id)
        ? applyOfflineFormEvent(current, form.id, { state, type: "pulled" })
        : current;
    });
  }
}
