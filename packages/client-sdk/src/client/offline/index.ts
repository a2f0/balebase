import type { FormTemplate } from "@balebase/validators/forms";
import type { IssueInput } from "@balebase/validators/issues";
import type { OfflineScope } from "@balebase/validators/offline";
import type { OfflineIdentity } from "../../data/offline/offlineWorkspace";
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
 * work. Cross-tab drains and pulls take Web Locks. Every member is bound, so
 * it can be passed on as a callback.
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
  readonly scopeKey = (scope: OfflineScope) =>
    this.#runtime.store.scopeKey(scope);

  /** The active workspace's key, or null while none is unlocked. */
  readonly activeKey = () => this.#runtime.store.activeKey();

  /** Changes whenever the device locks, here or in another tab. */
  readonly accessEpoch = () => this.#runtime.store.accessEpoch();

  /** Makes `key` active, unless the device locked since `epoch`. */
  readonly activate = (key: string, epoch?: string) => {
    this.#runtime.store.activate(key, epoch);
  };

  /** Hides the active workspace, as on sign-out, without deleting work. */
  readonly lock = () => {
    this.#runtime.store.lock();
  };

  /** Locks unless the active workspace is this person's (and organization's). */
  readonly lockOther = (userId: string, organizationId: string | undefined) => {
    this.#runtime.store.lockOther(userId, organizationId);
  };

  /** The workspace stored under `key`, if this device has one. */
  readonly read = (key: string) => this.#runtime.store.read(key);

  /** A photo saved with an issue raised on this device. */
  readonly image = (key: string, id: string) =>
    this.#runtime.store.image(key, id);

  /** Starts a form from `template`; resolves its ID. */
  readonly startForm = (
    key: string,
    template: FormTemplate,
    projectId: string,
  ) => startOfflineForm(this.#runtime.store, key, template, projectId);

  /**
   * Saves an answer to one of a form's items on the device, given over the
   * server answer `base`; it syncs with the form's next save or completion.
   */
  readonly saveAnswer = (
    key: string,
    id: string,
    itemId: string,
    answer: { at: string; base: string | null; value: string },
  ) => saveOfflineAnswer(this.#runtime.store, key, id, itemId, answer);

  /** Shares a draft with the server as an in-progress form. */
  readonly saveProgress = (key: string, id: string) =>
    saveOfflineProgress(this.#runtime.store, key, id);

  /**
   * Completes a form and queues the completion, with any answers not yet
   * shared; refuses while a required item is unanswered.
   */
  readonly completeForm = (key: string, id: string) =>
    completeOfflineForm(this.#runtime.store, key, id);

  /** Saves an issue raised on a form's item, with its photos. */
  readonly createIssue = (
    key: string,
    input: IssueInput,
    files: File[],
    target: { formId: string; itemId: string },
  ) => createOfflineIssue(this.#runtime.store, key, input, files, target);

  /** Sends every unsynced job again now, blocked ones included. */
  readonly retry = (key: string) => retryOfflineWork(this.#runtime.store, key);

  /**
   * Drains the active workspace's queue while online. Resolves whether this
   * call drained it: false when skipped (offline, another workspace, or a
   * drain in another tab).
   */
  readonly sync = (key: string) => syncOfflineWorkspace(this.#runtime, key);

  /**
   * Prepares the device for `identity` and brings its projects, templates,
   * and people up to date. Resolves whether it stored anything.
   */
  readonly pull = (identity: OfflineIdentity, epoch: string) =>
    pullOfflineWorkspace(this.#runtime, identity, epoch);

  /** Brings the device's shared forms up to date with the server's copies. */
  readonly pullForms = (identity: OfflineIdentity, epoch: string) =>
    pullOfflineForms(this.#runtime, identity, epoch);
}
