import { useEffect, useReducer, useRef, useState } from "react";
import { errorMessage } from "../shared/errors";
import { useUnsavedChanges } from "../workspace/unsavedChanges";
import {
  initialOfflineAnswers,
  offlineAnswersError,
  offlineAnswersTransition,
} from "./offlineAnswersState";
import type { OfflineAudit } from "./offlineStore";
import { queueOfflineAudit, saveOfflineAnswer } from "./offlineWork";

/** Device storage the answers are written to; tests pass their own. */
export interface OfflineAnswerStorage {
  queueAudit: (key: string, auditId: string) => Promise<unknown>;
  saveAnswer: (
    key: string,
    auditId: string,
    itemId: string,
    value: string,
  ) => Promise<unknown>;
}

const deviceStorage: OfflineAnswerStorage = {
  queueAudit: queueOfflineAudit,
  saveAnswer: saveOfflineAnswer,
};

/**
 * An audit's answers, each written to the device as it is given. What went
 * wrong is one machine (`offlineAnswersState.ts`): a failed write lasts until
 * every answer is written, a failed completion until a save succeeds.
 */
export function useOfflineAnswers(
  audit: OfflineAudit,
  key: string,
  storage = deviceStorage,
) {
  const [responses, setResponses] = useState(audit.responses);
  const dirty = useRef<Record<string, { value: string }>>({});
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
      ...audit.responses,
      ...Object.fromEntries(
        Object.entries(dirty.current).map(([id, edit]) => [id, edit.value]),
      ),
    });
  }, [audit.responses]);
  function write(itemId: string, edit: { value: string }) {
    const result = writes.current.then(async () => {
      try {
        await storage.saveAnswer(key, audit.id, itemId, edit.value);
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
      if (dirty.current[itemId] === edit) delete dirty.current[itemId];
      if (Object.keys(dirty.current).length === 0)
        report({ type: "allWritten" });
    });
    // Preserve typing order within this tab, including after a failed write.
    writes.current = result.catch(() => undefined);
    return result;
  }
  async function answer(itemId: string, value: string) {
    const edit = { value };
    dirty.current[itemId] = edit;
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
  async function save(complete: boolean) {
    setSealing(true);
    setPending((count) => count + 1);
    // A failed write reports itself; only queueing reports here.
    let written = false;
    try {
      // Retry only unsaved edits. Already-saved answers may have been updated
      // by another tab; completion seals the latest durable snapshot.
      for (const [id, edit] of Object.entries(dirty.current))
        await write(id, edit);
      written = true;
      if (complete) await storage.queueAudit(key, audit.id);
      report({ type: "saved" });
    } catch (cause) {
      if (written)
        report({
          message: errorMessage(cause, "Could not queue audit."),
          type: "queueFailed",
        });
    } finally {
      setSealing(false);
      setPending((count) => count - 1);
    }
  }
  return { responses, pending, sealing, error, answer, save };
}
