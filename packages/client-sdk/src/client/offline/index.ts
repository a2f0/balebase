import type { FormTemplate } from "@balebase/validators/forms";
import type { IssueInput } from "@balebase/validators/issues";
import type { OfflineScope } from "@balebase/validators/offline";
import type {
  OfflineIdentity,
  OfflineWorkspace,
} from "../../data/offline/offlineWorkspace";
import { pullOfflineForms, pullOfflineWorkspace } from "./offlinePull";
import type { OfflineRuntime } from "./offlineRuntime";
import { syncOfflineWorkspace } from "./offlineSync";
import {
  completeOfflineForm,
  createOfflineIssue,
  retryOfflineWork,
  saveOfflineAnswer,
  saveOfflineProgress,
  startOfflineForm,
} from "./offlineWork";

/**
 * Work done on this device without a connection: forms and issues kept in
 * IndexedDB per person and organization, and the queue that syncs them. One
 * workspace is active at a time; locking hides it without deleting unsynced
 * work. Cross-tab drains and pulls take Web Locks.
 */
export class Offline {
  readonly #runtime: OfflineRuntime;

  constructor(runtime: OfflineRuntime) {
    this.#runtime = runtime;
  }

  /** Calls `listener` after each change made in this tab; returns an unsubscribe. */
  readonly subscribe = (listener: () => void) =>
    this.#runtime.store.subscribe(listener);

  /** The key of a person's workspace in an organization. */
  scopeKey(scope: OfflineScope) {
    return this.#runtime.store.scopeKey(scope);
  }

  /** A new, empty workspace for `identity`. */
  emptyWorkspace(identity: OfflineIdentity) {
    return this.#runtime.store.emptyWorkspace(identity);
  }

  /** The active workspace's key, or null while none is unlocked. */
  activeKey() {
    return this.#runtime.store.activeKey();
  }

  /** Changes whenever the device locks, here or in another tab. */
  accessEpoch() {
    return this.#runtime.store.accessEpoch();
  }

  /** Makes `key` active, unless the device locked since `epoch`. */
  activate(key: string, epoch?: string) {
    this.#runtime.store.activate(key, epoch);
  }

  /** Hides the active workspace, as on sign-out, without deleting work. */
  lock() {
    this.#runtime.store.lock();
  }

  /** Locks unless the active workspace is this person's (and organization's). */
  lockOther(userId: string, organizationId: string | undefined) {
    this.#runtime.store.lockOther(userId, organizationId);
  }

  read(key: string) {
    return this.#runtime.store.read(key);
  }

  /** Changes a workspace in one transaction, storing `images` with it. */
  change(
    key: string,
    change: (workspace: OfflineWorkspace | undefined) => OfflineWorkspace,
    images?: { id: string; file: Blob }[],
  ) {
    return this.#runtime.store.change(key, change, images);
  }

  /** A photo saved with an issue raised on this device. */
  image(key: string, id: string) {
    return this.#runtime.store.image(key, id);
  }

  /** Starts a form from `template`; resolves its ID. */
  startForm(key: string, template: FormTemplate, projectId: string) {
    return startOfflineForm(this.#runtime.store, key, template, projectId);
  }

  saveAnswer(
    key: string,
    id: string,
    itemId: string,
    answer: { at: string; base: string | null; value: string },
  ) {
    return saveOfflineAnswer(this.#runtime.store, key, id, itemId, answer);
  }

  /** Shares a draft with the server as an in-progress form. */
  saveProgress(key: string, id: string) {
    return saveOfflineProgress(this.#runtime.store, key, id);
  }

  completeForm(key: string, id: string) {
    return completeOfflineForm(this.#runtime.store, key, id);
  }

  /** Saves an issue raised on a form's item, with its photos. */
  createIssue(
    key: string,
    input: IssueInput,
    files: File[],
    target: { formId: string; itemId: string },
  ) {
    return createOfflineIssue(this.#runtime.store, key, input, files, target);
  }

  /** Sends every unsynced job again now, blocked ones included. */
  retry(key: string) {
    return retryOfflineWork(this.#runtime.store, key);
  }

  /**
   * Drains the active workspace's queue while online. Resolves whether this
   * call drained it: false when skipped (offline, another workspace, or a
   * drain in another tab).
   */
  sync(key: string) {
    return syncOfflineWorkspace(this.#runtime, key);
  }

  /**
   * Prepares the device for `identity` and brings its projects, templates,
   * and people up to date. Resolves whether it stored anything.
   */
  pull(identity: OfflineIdentity, epoch: string) {
    return pullOfflineWorkspace(this.#runtime, identity, epoch);
  }

  /** Brings the device's shared forms up to date with the server's copies. */
  pullForms(identity: OfflineIdentity, epoch: string) {
    return pullOfflineForms(this.#runtime, identity, epoch);
  }
}
