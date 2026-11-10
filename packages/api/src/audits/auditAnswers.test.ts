import { describe, expect, it } from "bun:test";
import {
  type IncomingAnswer,
  mergeAnswers,
  type StoredAnswer,
  savedAnswers,
} from "./auditAnswers";

const at = (minute: number) =>
  `2026-11-10T12:${String(minute).padStart(2, "0")}:00.000Z`;
/** An answer saved online at `minute`, by a save of its own. */
const online = (value: string, minute: number): StoredAnswer => ({
  at: at(minute),
  by: "online",
  value,
  version: `online@${minute}`,
});
/** An answer the device's save sets, given at `minute`. */
const device = (value: string, minute: number): StoredAnswer => ({
  at: at(minute),
  by: "device",
  value,
  version: "device-save",
});
/** An answer cleared online at `minute`. */
const cleared = (minute: number): StoredAnswer => ({
  ...online("", minute),
  value: null,
});
/** A device answer given at `minute` over the online answer of `base`. */
const write = (
  value: string,
  minute: number,
  base: number | null,
): IncomingAnswer => ({
  at: at(minute),
  base: base === null ? null : `online@${base}`,
  value,
});
const save = { by: "device", version: "device-save" };

describe("mergeAnswers", () => {
  it.each<
    [
      string,
      StoredAnswer | undefined,
      IncomingAnswer,
      boolean,
      { kept: StoredAnswer | undefined; conflict: boolean },
    ]
  >([
    [
      "applies an answer given over the stored one it saw",
      online("fail", 1),
      write("pass", 5, 1),
      false,
      { kept: device("pass", 5), conflict: false },
    ],
    [
      "detects an answer given since at the same time as the one it saw",
      { ...online("na", 1), version: "another-save" },
      write("pass", 5, 1),
      false,
      { kept: device("pass", 5), conflict: true },
    ],
    [
      "applies a first answer",
      undefined,
      write("pass", 5, null),
      false,
      { kept: device("pass", 5), conflict: false },
    ],
    [
      "keeps a later answer given since, recording the collision",
      online("na", 7),
      write("pass", 5, 1),
      false,
      { kept: online("na", 7), conflict: true },
    ],
    [
      "keeps an answer cleared after the one the device saw, recording the collision",
      cleared(7),
      write("pass", 5, 1),
      false,
      { kept: cleared(7), conflict: true },
    ],
    [
      "replaces an answer cleared before the device's, recording the collision",
      cleared(3),
      write("pass", 5, 1),
      false,
      { kept: device("pass", 5), conflict: true },
    ],
    [
      "replaces an earlier answer given since, recording the collision",
      online("na", 3),
      write("pass", 5, 1),
      false,
      { kept: device("pass", 5), conflict: true },
    ],
    [
      "keeps the stored answer on a tie",
      online("na", 5),
      write("pass", 5, 1),
      false,
      { kept: online("na", 5), conflict: true },
    ],
    [
      "leaves agreeing answers alone",
      online("pass", 7),
      write("pass", 5, 1),
      false,
      { kept: online("pass", 7), conflict: false },
    ],
    [
      "keeps a completed audit's answer however late the device's",
      online("fail", 1),
      write("pass", 9, 1),
      true,
      { kept: online("fail", 1), conflict: true },
    ],
    [
      "keeps a completed audit's item unanswered",
      undefined,
      write("pass", 9, null),
      true,
      { kept: undefined, conflict: true },
    ],
  ])("%s", (_name, stored, incoming, sealed, expected) => {
    const merged = mergeAnswers(
      stored ? { check: stored } : {},
      { check: incoming },
      save,
      sealed,
    );
    expect(merged.answers).toEqual(
      expected.kept ? { check: expected.kept } : {},
    );
    expect(merged.changed).toBe(expected.kept?.by === "device");
    // A conflict records the answer that stayed.
    expect(merged.conflicts.map(({ kept }) => kept)).toEqual(
      expected.conflict ? [expected.kept ?? null] : [],
    );
  });
});

describe("merging in either order", () => {
  const agreeing = write("pass", 7, 5);
  const differing = write("fail", 6, 1);
  it.each([
    ["the agreeing answer first", [agreeing, differing]],
    ["the differing answer first", [differing, agreeing]],
  ])("keeps the latest answer with %s", (_name, writes) => {
    let stored: Record<string, StoredAnswer> = { check: online("pass", 5) };
    for (const incoming of writes)
      stored = mergeAnswers(stored, { check: incoming }, save, false).answers;
    expect(stored).toEqual({ check: device("pass", 7) });
  });
});

describe("savedAnswers", () => {
  it("stamps changed, new, and left-out answers with the save and keeps the rest", () => {
    const stored = {
      check: online("pass", 1),
      notes: online("Rail", 1),
      photo: online("Taken", 1),
      gone: cleared(2),
    };
    expect(
      savedAnswers(
        stored,
        { check: "pass", notes: "Rail fixed", extra: "New" },
        { at: at(9), by: "editor", version: "edit" },
      ),
    ).toEqual({
      check: online("pass", 1),
      notes: { at: at(9), by: "editor", value: "Rail fixed", version: "edit" },
      extra: { at: at(9), by: "editor", value: "New", version: "edit" },
      // Cleared by this save, keeping when, by whom, and which save.
      photo: { at: at(9), by: "editor", value: null, version: "edit" },
      gone: cleared(2),
    });
  });
});
