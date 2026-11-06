import { describe, expect, it } from "bun:test";
import {
  initialSyncPoll,
  type SyncPollEvent,
  type SyncPollState,
  syncPollError,
  syncPollTransition,
} from "./syncPollState";

const polling = (job: string): SyncPollState => ({ job, status: "polling" });
const failed = (job: string): SyncPollState => ({
  job,
  message: "Try again.",
  status: "failed",
});

describe("sync poll state", () => {
  it.each<[string, SyncPollState, SyncPollEvent, SyncPollState]>([
    [
      "starts polling a pending job",
      initialSyncPoll,
      { job: "a", type: "pendingSeen" },
      polling("a"),
    ],
    [
      "keeps polling the same job",
      polling("a"),
      { job: "a", type: "pendingSeen" },
      polling("a"),
    ],
    [
      "keeps a failure while its job is pending",
      failed("a"),
      { job: "a", type: "pendingSeen" },
      failed("a"),
    ],
    [
      "drops a failure when the job stops pending",
      failed("a"),
      { job: null, type: "pendingSeen" },
      initialSyncPoll,
    ],
    [
      "drops a failure when another job is pending",
      failed("a"),
      { job: "b", type: "pendingSeen" },
      polling("b"),
    ],
    [
      "stops polling when nothing is pending",
      polling("a"),
      { job: null, type: "pendingSeen" },
      initialSyncPoll,
    ],
    [
      "records a failed poll",
      polling("a"),
      { job: "a", message: "Try again.", type: "pollFailed" },
      failed("a"),
    ],
    [
      "clears a failure on a good poll",
      failed("a"),
      { job: "a", type: "pollSucceeded" },
      polling("a"),
    ],
    [
      "ignores another job's failure",
      polling("b"),
      { job: "a", message: "Try again.", type: "pollFailed" },
      polling("b"),
    ],
    [
      "ignores a failure when idle",
      initialSyncPoll,
      { job: "a", message: "Try again.", type: "pollFailed" },
      initialSyncPoll,
    ],
    [
      "ignores another job's success",
      failed("b"),
      { job: "a", type: "pollSucceeded" },
      failed("b"),
    ],
  ])("%s", (_name, state, event, next) => {
    expect(syncPollTransition(state, event)).toEqual(next);
  });

  it("shows an error only while failed", () => {
    expect(syncPollError(failed("a"))).toBe("Try again.");
    expect(syncPollError(polling("a"))).toBeUndefined();
    expect(syncPollError(initialSyncPoll)).toBeUndefined();
  });
});
