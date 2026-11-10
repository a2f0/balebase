import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { errorMessage } from "../shared/errors";
import { useUnsavedChanges } from "../workspace/unsavedChanges";
import {
  initialOfflineAnswers,
  offlineAnswersError,
  offlineAnswersTransition,
} from "./offlineAnswersState";
import { answerBase, offlineAnswers } from "./offlineAuditState";
import type { OfflineAudit } from "./offlineStore";
import {
  completeOfflineAudit,
  saveOfflineAnswer,
  saveOfflineProgress,
} from "./offlineWork";

/** Device storage the answers are written to; tests pass their own. */
export interface OfflineAnswerStorage {
  completeAudit: (key: string, auditId: string) => Promise<unknown>;
  saveAnswer: (
    key: string,
    auditId: string,
    itemId: string,
    answer: Edit,
  ) => Promise<unknown>;
  saveProgress: (key: string, auditId: string) => Promise<unknown>;
}

const deviceStorage: OfflineAnswerStorage = {
  completeAudit: completeOfflineAudit,
  saveAnswer: saveOfflineAnswer,
  saveProgress: saveOfflineProgress,
};

/** What a save queues to sync after writing every answer to the device. */
export type OfflineAuditSync = "progress" | "completion";

/**
 * An answer as given: when, over which server answer (`answerBase`), and
 * what. A write retried later keeps all three.
 */
export interface Edit {
  at: string;
  base: string | null;
  value: string;
}

/**
 * An audit's answers, each written to the device as it is given. What went
 * wrong is one machine (`offlineAnswersState.ts`): a failed write lasts until
 * every answer is written, a failed sync request until a save succeeds.
 */
export function useOfflineAnswers(
  audit: OfflineAudit,
  key: string,
  storage = deviceStorage,
) {
  const saved = useMemo(() => offlineAnswers(audit), [audit]);
  const [responses, setResponses] = useState(saved);
  // Each unwritten answer keeps the base it was given over. Item IDs are any
  // text, so they key a Map rather than an object's inherited members.
  const dirty = useRef(new Map<string, Edit>());
  const writes = useRef(Promise.resolve());
  const [pending, setPending] = useState(0);
  const [failures, report] = useReducer(
    offlineAnswersTransition,
    initialOfflineAnswers,
  );
  const [sealing, setSealing] = useState(false);
  const error = offlineAnswersError(failures);
  useUnsavedChanges(
    pending > 0 || Boolean(error),
    "Some audit answers have not been saved on this device.",
  );
  useEffect(() => {
    setResponses({
      ...saved,
      ...Object.fromEntries(
        [...dirty.current].map(([id, edit]) => [id, edit.value]),
      ),
    });
  }, [saved]);
  function write(itemId: string, edit: Edit) {
    const result = writes.current.then(async () => {
      try {
        await storage.saveAnswer(key, audit.id, itemId, edit);
      } catch (cause) {
        report({
          message: errorMessage(
            cause,
            "Answer not saved. Check device storage and retry.",
          ),
          type: "writeFailed",
        });
        throw cause;
      }
      if (dirty.current.get(itemId) === edit) dirty.current.delete(itemId);
      if (dirty.current.size === 0) report({ type: "allWritten" });
    });
    // Preserve typing order within this tab, including after a failed write.
    writes.current = result.catch(() => undefined);
    return result;
  }
  async function answer(itemId: string, value: string) {
    // Given now, over what this render shows, not over what storage holds
    // by the time the write runs. An answer replacing one not yet written
    // keeps that one's base, which may be null.
    const unwritten = dirty.current.get(itemId);
    const edit: Edit = {
      at: new Date().toISOString(),
      base: unwritten ? unwritten.base : answerBase(audit, itemId),
      value,
    };
    dirty.current.set(itemId, edit);
    setResponses((current) => ({ ...current, [itemId]: value }));
    setPending((count) => count + 1);
    try {
      await write(itemId, edit);
    } catch {
      // Reported as the write failed.
    } finally {
      setPending((count) => count - 1);
    }
  }
  /** Writes any unsaved answers, then queues `sync`, if given. */
  async function save(sync?: OfflineAuditSync) {
    setSealing(true);
    setPending((count) => count + 1);
    // A failed write reports itself; only queueing reports here.
    let written = false;
    try {
      // Retry only unsaved edits. Already-saved answers may have been updated
      // by another tab; a sync takes the latest durable snapshot.
      for (const [id, edit] of [...dirty.current]) await write(id, edit);
      written = true;
      if (sync === "progress") await storage.saveProgress(key, audit.id);
      if (sync === "completion") await storage.completeAudit(key, audit.id);
      report({ type: "saved" });
    } catch (cause) {
      if (written)
        report({
          message: errorMessage(
            cause,
            sync === "progress"
              ? "Could not save progress."
              : "Could not queue audit.",
          ),
          type: "queueFailed",
        });
    } finally {
      setSealing(false);
      setPending((count) => count - 1);
    }
  }
  return { responses, pending, sealing, error, answer, save };
}
