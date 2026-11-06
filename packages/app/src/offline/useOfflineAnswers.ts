import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../shared/errors";
import { useUnsavedChanges } from "../workspace/unsavedChanges";
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
 * An audit's answers, each written to the device as it is given. A failed
 * answer's error lasts only while some answer is still unsaved: answering
 * again, once every edit is written, clears it. A failed completion keeps its
 * error until a save succeeds, since its answers may all be written.
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
  const [answerError, setAnswerError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [sealing, setSealing] = useState(false);
  const error = saveError ?? answerError;
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
      await storage.saveAnswer(key, audit.id, itemId, edit.value);
      if (dirty.current[itemId] === edit) delete dirty.current[itemId];
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
      if (Object.keys(dirty.current).length === 0) setAnswerError(undefined);
    } catch (cause) {
      setAnswerError(
        errorMessage(
          cause,
          "Answer not saved. Check device storage and retry.",
        ),
      );
    } finally {
      setPending((count) => count - 1);
    }
  }
  async function save(complete: boolean) {
    setSealing(true);
    setPending((count) => count + 1);
    try {
      // Retry only unsaved edits. Already-saved answers may have been updated
      // by another tab; completion seals the latest durable snapshot.
      for (const [id, edit] of Object.entries(dirty.current))
        await write(id, edit);
      if (complete) await storage.queueAudit(key, audit.id);
      setAnswerError(undefined);
      setSaveError(undefined);
    } catch (cause) {
      setSaveError(errorMessage(cause, "Could not queue audit."));
    } finally {
      setSealing(false);
      setPending((count) => count - 1);
    }
  }
  return { responses, pending, sealing, error, answer, save };
}
