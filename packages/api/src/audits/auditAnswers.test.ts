import { describe, expect, it } from "bun:test";
import {
  type IncomingAnswer,
  mergeAnswers,
  type StoredAnswer,
  savedAnswers,
} from "./auditAnswers";

const at = (minute: number) =>
  `2026-11-10T12:${String(minute).padStart(2, "0")}:00.000Z`;
const online = (value: string, minute: number): StoredAnswer => ({
  at: at(minute),
  by: "online",
  value,
});
const device = (value: string, minute: number): StoredAnswer => ({
  at: at(minute),
  by: "device",
  value,
});
const write = (
  value: string,
  minute: number,
  base: number | null,
): IncomingAnswer => ({
  at: at(minute),
  base: base === null ? null : at(base),
  value,
});

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
      "device",
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

describe("savedAnswers", () => {
  it("stamps changed and new answers with the save and keeps the rest", () => {
    const stored = { check: online("pass", 1), notes: online("Rail", 1) };
    expect(
      savedAnswers(
        stored,
        { check: "pass", notes: "Rail fixed", extra: "New" },
        { at: at(9), by: "editor" },
      ),
    ).toEqual({
      check: online("pass", 1),
      notes: { at: at(9), by: "editor", value: "Rail fixed" },
      extra: { at: at(9), by: "editor", value: "New" },
    });
  });
});
