import { isRecord } from "../shared/jsonInput";

/**
 * An audit's answer, with the time it was given and who gave it as recorded.
 * A cleared answer keeps its time and author with a null value, so an older
 * answer from a device cannot bring it back unnoticed.
 */
export interface StoredAnswer {
  at: string | null;
  by: string | null;
  value: string | null;
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

/**
 * The answers of an audit row: each in `responses`, and each cleared one
 * `answer_meta` still holds the time of.
 */
export function storedAnswers(row: {
  answer_meta: string;
  responses: string;
}): Record<string, StoredAnswer> {
  const responses = JSON.parse(row.responses) as Record<string, string>;
  const parsed: unknown = JSON.parse(row.answer_meta);
  const meta = isRecord(parsed) ? parsed : {};
  const answers: Record<string, StoredAnswer> = {};
  for (const itemId of new Set([
    ...Object.keys(responses),
    ...Object.keys(meta),
  ])) {
    const entry = meta[itemId];
    const known = isRecord<"at" | "by">(entry) ? entry : undefined;
    answers[itemId] = {
      at: typeof known?.at === "string" ? known.at : null,
      by: typeof known?.by === "string" ? known.by : null,
      value: responses[itemId] ?? null,
    };
  }
  return answers;
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

/** The answers given, without cleared ones. */
export function answerValues(answers: Record<string, StoredAnswer>) {
  return Object.fromEntries(
    Object.entries(answers).flatMap(([itemId, { value }]) =>
      value === null ? [] : [[itemId, value]],
    ),
  );
}

/**
 * The answers after a save of `responses`: each changed or new answer takes
 * the save's time and author, unchanged ones keep theirs, and each one the
 * save leaves out is cleared at the save's time.
 */
export function savedAnswers(
  stored: Record<string, StoredAnswer>,
  responses: Record<string, string>,
  write: { at: string; by: string },
): Record<string, StoredAnswer> {
  const answers: Record<string, StoredAnswer> = {};
  for (const [itemId, value] of Object.entries(responses)) {
    const current = stored[itemId];
    answers[itemId] = current?.value === value ? current : { ...write, value };
  }
  for (const [itemId, current] of Object.entries(stored))
    if (!(itemId in responses))
      answers[itemId] =
        current.value === null ? current : { ...write, value: null };
  return answers;
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
