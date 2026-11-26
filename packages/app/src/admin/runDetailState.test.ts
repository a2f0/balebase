import { describe, expect, it } from "bun:test";
import type { JobRun } from "@balebase/validators/adminJobs";
import {
  initialRunDetail,
  type RunDetail,
  type RunDetailEvent,
  type RunDetailState,
  runDetailTransition,
} from "./runDetailState";

const job: JobRun = {
  runId: "run-1",
  jobId: "purgeRequestedUsers",
  status: "running",
  source: "manual",
  dryRun: false,
  requestedBy: "actor",
  requestedByName: "Admin Actor",
  requestedByEmail: "actor@example.com",
  organizationId: null,
  connectionId: null,
  attempts: 1,
  createdAt: "2026-10-26T12:00:00.000Z",
  startedAt: "2026-10-26T12:00:01.000Z",
  finishedAt: null,
  availableAt: "2026-10-26T12:00:00.000Z",
  durationMs: null,
  error: null,
  errorCode: null,
  output: null,
};
const detail: RunDetail = { run: job, logs: [], nextBefore: null };
const later: RunDetail = { ...detail, run: { ...job, status: "succeeded" } };

function run(state: RunDetailState, ...events: RunDetailEvent[]) {
  return events.reduce<RunDetailState>(runDetailTransition, state);
}

describe("runDetailTransition", () => {
  it.each<[string, RunDetailState, RunDetailEvent, RunDetailState]>([
    [
      "starts reading another run or page with nothing shown",
      { status: "loaded", request: 1, detail, error: "Offline." },
      { type: "opened", request: 2 },
      { status: "loading", request: 2 },
    ],
    [
      "reads again after a failure with nothing to show",
      { status: "failed", request: 1, error: "Offline." },
      { type: "retried", request: 2 },
      { status: "loading", request: 2 },
    ],
    [
      "replaces a read in flight on a retry",
      { status: "loading", request: 1 },
      { type: "retried", request: 2 },
      { status: "loading", request: 2 },
    ],
    [
      "keeps the details and clears the error on a retry",
      { status: "loaded", request: 1, detail, error: "Offline." },
      { type: "retried", request: 2 },
      { status: "loaded", request: 2, detail },
    ],
    [
      "shows the first read",
      { status: "loading", request: 1 },
      { type: "read", request: 1, detail },
      { status: "loaded", request: 1, detail },
    ],
    [
      "replaces the details with a later read, clearing its error",
      { status: "loaded", request: 1, detail, error: "Offline." },
      { type: "read", request: 1, detail: later },
      { status: "loaded", request: 1, detail: later },
    ],
    [
      "fails with nothing to show",
      { status: "loading", request: 1 },
      { type: "readFailed", request: 1, error: "Offline." },
      { status: "failed", request: 1, error: "Offline." },
    ],
    [
      "keeps the details when a later read fails",
      { status: "loaded", request: 1, detail },
      { type: "readFailed", request: 1, error: "Offline." },
      { status: "loaded", request: 1, detail, error: "Offline." },
    ],
  ])("%s", (_name, state, event, next) => {
    expect(runDetailTransition(state, event)).toEqual(next);
  });

  it.each<[string, RunDetailState, RunDetailEvent]>([
    [
      "a read for another request",
      { status: "loading", request: 2 },
      { type: "read", request: 1, detail },
    ],
    [
      "a failure for another request while loading",
      { status: "loading", request: 2 },
      { type: "readFailed", request: 1, error: "Offline." },
    ],
    [
      "a failure for another request once loaded",
      { status: "loaded", request: 2, detail },
      { type: "readFailed", request: 1, error: "Offline." },
    ],
    [
      "a read for another request after a failure",
      { status: "failed", request: 2, error: "Offline." },
      { type: "read", request: 1, detail },
    ],
  ])("ignores %s", (_name, state, event) => {
    expect(runDetailTransition(state, event)).toBe(state);
  });

  it("starts reading with nothing shown", () => {
    expect(initialRunDetail).toEqual({ status: "loading", request: 0 });
  });

  it("drops a read for a page the admin left", () => {
    expect(
      run(
        initialRunDetail,
        { type: "retried", request: 1 },
        { type: "opened", request: 2 },
        { type: "read", request: 1, detail },
      ),
    ).toEqual({ status: "loading", request: 2 });
  });

  it("drops a failure from a request a retry replaced", () => {
    expect(
      run(
        { status: "loaded", request: 1, detail },
        { type: "retried", request: 2 },
        { type: "readFailed", request: 1, error: "Offline." },
        { type: "read", request: 2, detail: later },
      ),
    ).toEqual({ status: "loaded", request: 2, detail: later });
  });

  it("rejects an event it does not know", () => {
    expect(() =>
      runDetailTransition(initialRunDetail, { type: "unknown" } as never),
    ).toThrow("Unhandled run detail event");
  });
});
