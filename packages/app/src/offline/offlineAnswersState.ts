/**
 * What went wrong saving an audit's answers on this device. A failed write
 * lasts until every answer is written, however that happens (answering again
 * or a retried save); a failed completion lasts until a save succeeds. A
 * failed write shows first: it is what the person can act on now.
 */
export interface OfflineAnswersState {
  queueError: string | undefined;
  writeError: string | undefined;
}

export type OfflineAnswersEvent =
  | { message: string; type: "writeFailed" }
  /** Every answer is written; nothing is left unsaved. */
  | { type: "allWritten" }
  | { message: string; type: "queueFailed" }
  /** A save finished: every answer written and, if completing, queued. */
  | { type: "saved" };

export const initialOfflineAnswers: OfflineAnswersState = {
  queueError: undefined,
  writeError: undefined,
};

export function offlineAnswersTransition(
  state: OfflineAnswersState,
  event: OfflineAnswersEvent,
): OfflineAnswersState {
  switch (event.type) {
    case "writeFailed":
      return { ...state, writeError: event.message };
    case "allWritten":
      return { ...state, writeError: undefined };
    case "queueFailed":
      return { ...state, queueError: event.message };
    case "saved":
      return initialOfflineAnswers;
    default:
      return unknownEvent(event);
  }
}

export function offlineAnswersError(state: OfflineAnswersState) {
  return state.writeError ?? state.queueError;
}

function unknownEvent(event: never): never {
  throw new Error(`Unknown offline answers event: ${JSON.stringify(event)}`);
}
