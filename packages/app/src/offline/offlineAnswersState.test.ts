import { describe, expect, it } from "bun:test";
import {
  initialOfflineAnswers,
  type OfflineAnswersEvent,
  offlineAnswersError,
  offlineAnswersTransition,
} from "./offlineAnswersState";

const run = (...events: OfflineAnswersEvent[]) =>
  events.reduce(offlineAnswersTransition, initialOfflineAnswers);
const writeFailed: OfflineAnswersEvent = {
  message: "Storage full.",
  type: "writeFailed",
};
const queueFailed: OfflineAnswersEvent = {
  message: "Queue unavailable.",
  type: "queueFailed",
};

describe("offline answers state", () => {
  it.each<[string, OfflineAnswersEvent[], string | undefined]>([
    ["shows a failed write", [writeFailed], "Storage full."],
    [
      "clears it once all is written",
      [writeFailed, { type: "allWritten" }],
      undefined,
    ],
    ["shows a failed completion", [queueFailed], "Queue unavailable."],
    [
      "keeps a completion's failure after writes",
      [queueFailed, { type: "allWritten" }],
      "Queue unavailable.",
    ],
    [
      "shows a failed write over a completion's",
      [queueFailed, writeFailed],
      "Storage full.",
    ],
    [
      "returns to the completion's after writes",
      [queueFailed, writeFailed, { type: "allWritten" }],
      "Queue unavailable.",
    ],
    [
      "clears everything on a finished save",
      [queueFailed, writeFailed, { type: "saved" }],
      undefined,
    ],
  ])("%s", (_name, events, error) => {
    expect(offlineAnswersError(run(...events))).toBe(error);
  });
});
