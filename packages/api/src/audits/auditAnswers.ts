import { isRecord } from "../shared/jsonInput";

/** An audit's answer, with the time it was given and who gave it as recorded. */
export interface StoredAnswer {
  at: string | null;
  by: string | null;
  value: string;
}

/** An answer a device gave at `at`, over the stored answer of time `base`. */
export interface IncomingAnswer {
  at: string;
  base: string | null;
  value: string;
}

/**
 * Two answers to one item given without either knowing of the other. The
 * later stays; the other is recorded. `kept` is null when the item stays
 * unanswered.
 */
export interface AnswerConflict {
  discarded: StoredAnswer;
  itemId: string;
  kept: StoredAnswer | null;
}

/** The answers of an audit row, from its `responses` and `answer_meta`. */
export function storedAnswers(row: {
  answer_meta: string;
  responses: string;
}): Record<string, StoredAnswer> {
  const responses = JSON.parse(row.responses) as Record<string, string>;
  const meta: unknown = JSON.parse(row.answer_meta);
  return Object.fromEntries(
    Object.entries(responses).map(([itemId, value]) => {
      const entry = isRecord(meta) ? meta[itemId] : undefined;
      const known = isRecord<"at" | "by">(entry) ? entry : undefined;
      return [
        itemId,
        {
          at: typeof known?.at === "string" ? known.at : null,
          by: typeof known?.by === "string" ? known.by : null,
          value,
        },
      ];
    }),
  );
}

/** The `responses` and `answer_meta` columns that store `answers`. */
export function answerColumns(answers: Record<string, StoredAnswer>) {
  return {
    answerMeta: JSON.stringify(
      Object.fromEntries(
        Object.entries(answers).flatMap(([itemId, { at, by }]) =>
          at && by ? [[itemId, { at, by }]] : [],
        ),
      ),
    ),
    responses: JSON.stringify(answerValues(answers)),
  };
}

export function answerValues(answers: Record<string, StoredAnswer>) {
  return Object.fromEntries(
    Object.entries(answers).map(([itemId, { value }]) => [itemId, value]),
  );
}

/**
 * The answers after a save of `responses`: each changed or new answer takes
 * the save's time and author, unchanged ones keep theirs, and absent ones
 * are gone.
 */
export function savedAnswers(
  stored: Record<string, StoredAnswer>,
  responses: Record<string, string>,
  write: { at: string; by: string },
): Record<string, StoredAnswer> {
  return Object.fromEntries(
    Object.entries(responses).map(([itemId, value]) => {
      const current = stored[itemId];
      return [itemId, current?.value === value ? current : { ...write, value }];
    }),
  );
}

/**
 * Merges a device's answers into the stored ones, last writer wins by the
 * time each answer was given.
 *
 * An answer given over the stored answer the device last saw replaces it.
 * One given over an older answer collides with the answer given since: the
 * later of the two stays (the stored one on a tie), and the pair is a
 * conflict. Agreeing answers never conflict. A sealed (completed) audit
 * keeps every answer, so each differing answer is a conflict it discards.
 */
export function mergeAnswers(
  stored: Record<string, StoredAnswer>,
  incoming: Record<string, IncomingAnswer>,
  by: string,
  sealed: boolean,
) {
  const answers = { ...stored };
  const conflicts: AnswerConflict[] = [];
  let changed = false;
  for (const [itemId, write] of Object.entries(incoming)) {
    const current = stored[itemId];
    const given: StoredAnswer = { at: write.at, by, value: write.value };
    if (current?.value === write.value) continue;
    if (sealed) {
      conflicts.push({ discarded: given, itemId, kept: current ?? null });
      continue;
    }
    const concurrent = current !== undefined && current.at !== write.base;
    if (
      concurrent &&
      current.at !== null &&
      Date.parse(current.at) >= Date.parse(write.at)
    ) {
      conflicts.push({ discarded: given, itemId, kept: current });
      continue;
    }
    answers[itemId] = given;
    changed = true;
    if (concurrent) conflicts.push({ discarded: current, itemId, kept: given });
  }
  return { answers, changed, conflicts };
}
