import { isRecord } from "../shared/jsonInput";

/**
 * An audit's answer, with the time it was given, who gave it, and the
 * version that identifies the write that set it, as recorded. A cleared
 * answer keeps all three with a null value, so an older answer from a device
 * cannot bring it back unnoticed.
 */
export interface StoredAnswer {
  at: string | null;
  by: string | null;
  value: string | null;
  version: string | null;
}

/** A write that sets answers: when, by whom, and its unique version. */
export interface AnswerWrite {
  at: string;
  by: string;
  version: string;
}

/**
 * An answer a device gave at `at`, over the stored answer of version `base`,
 * the one it showed.
 */
export interface IncomingAnswer {
  at: string;
  base: string | null;
  value: string;
}

/**
 * Two answers to one item given without either knowing of the other. The
 * later stays; the other is recorded. A kept answer that is null, or has a
 * null value, leaves the item unanswered.
 */
export interface AnswerConflict {
  discarded: StoredAnswer;
  itemId: string;
  kept: StoredAnswer | null;
}

/**
 * `record[key]` if `key` is its own property. Item IDs are any text, so IDs
 * such as `constructor` must not find inherited members.
 */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
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
  const itemIds = new Set([...Object.keys(responses), ...Object.keys(meta)]);
  return Object.fromEntries(
    [...itemIds].map((itemId) => {
      const entry = own(meta, itemId);
      const known = isRecord<"at" | "by" | "v">(entry) ? entry : undefined;
      const answer: StoredAnswer = {
        at: typeof known?.at === "string" ? known.at : null,
        by: typeof known?.by === "string" ? known.by : null,
        value: own(responses, itemId) ?? null,
        version: typeof known?.v === "string" ? known.v : null,
      };
      return [itemId, answer];
    }),
  );
}

/** The `responses` and `answer_meta` columns that store `answers`. */
export function answerColumns(answers: Record<string, StoredAnswer>) {
  return {
    answerMeta: JSON.stringify(
      Object.fromEntries(
        Object.entries(answers).flatMap(([itemId, { at, by, version }]) =>
          at && by && version ? [[itemId, { at, by, v: version }]] : [],
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
 * the save's time, author, and version, unchanged ones keep theirs, and each
 * one the save leaves out is cleared by the save.
 */
export function savedAnswers(
  stored: Record<string, StoredAnswer>,
  responses: Record<string, string>,
  write: AnswerWrite,
): Record<string, StoredAnswer> {
  const given = Object.entries(responses).map(([itemId, value]) => {
    const current = own(stored, itemId);
    return [itemId, current?.value === value ? current : { ...write, value }];
  });
  const cleared = Object.entries(stored).flatMap(([itemId, current]) =>
    Object.hasOwn(responses, itemId)
      ? []
      : [
          [
            itemId,
            current.value === null ? current : { ...write, value: null },
          ],
        ],
  );
  return Object.fromEntries([...given, ...cleared]);
}

/**
 * Merges a device's answers, each set by write `version`, into the stored
 * ones, last writer wins by the time each answer was given.
 *
 * An answer given over the stored answer the device last saw (its `base` is
 * that answer's version) replaces it. One given over another answer collides
 * with the answer given since: the later of the two stays (the stored one on
 * a tie), and the pair is a conflict. Agreeing answers never conflict, but
 * the answer keeps the later time, so the outcome does not depend on the
 * order answers arrive in. A sealed (completed) audit keeps every answer, so
 * each differing answer is a conflict it discards.
 */
export function mergeAnswers(
  stored: Record<string, StoredAnswer>,
  incoming: Record<string, IncomingAnswer>,
  write: Pick<AnswerWrite, "by" | "version">,
  sealed: boolean,
) {
  const answers = new Map(Object.entries(stored));
  const conflicts: AnswerConflict[] = [];
  let changed = false;
  for (const [itemId, answer] of Object.entries(incoming)) {
    const current = own(stored, itemId);
    const given: StoredAnswer = {
      at: answer.at,
      by: write.by,
      value: answer.value,
      version: write.version,
    };
    const newer =
      !current?.at || Date.parse(answer.at) > Date.parse(current.at);
    if (current?.value === answer.value) {
      if (newer && !sealed) {
        answers.set(itemId, given);
        changed = true;
      }
      continue;
    }
    if (sealed) {
      conflicts.push({ discarded: given, itemId, kept: current ?? null });
      continue;
    }
    const concurrent = current !== undefined && current.version !== answer.base;
    if (concurrent && !newer) {
      conflicts.push({ discarded: given, itemId, kept: current });
      continue;
    }
    answers.set(itemId, given);
    changed = true;
    if (concurrent) conflicts.push({ discarded: current, itemId, kept: given });
  }
  return { answers: Object.fromEntries(answers), changed, conflicts };
}
