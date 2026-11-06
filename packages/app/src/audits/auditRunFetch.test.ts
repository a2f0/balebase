import { describe, expect, it } from "bun:test";
import {
  type AuditRunFetch,
  type AuditRunFetchEvent,
  auditRunFetchTransition,
  initialAuditRunFetch,
} from "./auditRunFetch";

const fetching = (request: number, full: boolean): AuditRunFetch => ({
  full,
  request,
  status: "fetching",
});
const failed = (full: boolean): AuditRunFetch => ({
  full,
  message: "Try again.",
  status: "failed",
});

describe("audit run fetch", () => {
  it.each<[string, AuditRunFetch, AuditRunFetchEvent, AuditRunFetch]>([
    [
      "starts a full read",
      initialAuditRunFetch,
      { full: true, request: 1, type: "started" },
      fetching(1, true),
    ],
    [
      "starts an issues read",
      initialAuditRunFetch,
      { full: false, request: 1, type: "started" },
      fetching(1, false),
    ],
    [
      "keeps a replaced full read full",
      fetching(1, true),
      { full: false, request: 2, type: "started" },
      fetching(2, true),
    ],
    [
      "upgrades a replaced issues read",
      fetching(1, false),
      { full: true, request: 2, type: "started" },
      fetching(2, true),
    ],
    [
      "keeps a failed full read full",
      failed(true),
      { full: false, request: 2, type: "started" },
      fetching(2, true),
    ],
    [
      "reads issues after a failed issues read",
      failed(false),
      { full: false, request: 2, type: "started" },
      fetching(2, false),
    ],
    [
      "lands the current read",
      fetching(2, true),
      { request: 2, type: "landed" },
      initialAuditRunFetch,
    ],
    [
      "ignores a replaced read landing",
      fetching(2, true),
      { request: 1, type: "landed" },
      fetching(2, true),
    ],
    [
      "fails the current read",
      fetching(2, true),
      { message: "Try again.", request: 2, type: "failed" },
      failed(true),
    ],
    [
      "ignores a replaced read failing",
      fetching(2, false),
      { message: "Try again.", request: 1, type: "failed" },
      fetching(2, false),
    ],
    [
      "ignores a failure when idle",
      initialAuditRunFetch,
      { message: "Try again.", request: 1, type: "failed" },
      initialAuditRunFetch,
    ],
    [
      "ignores a landing when failed",
      failed(true),
      { request: 1, type: "landed" },
      failed(true),
    ],
  ])("%s", (_name, state, event, next) => {
    expect(auditRunFetchTransition(state, event)).toEqual(next);
  });

  it("lets only the newest read land, still full", () => {
    const events: AuditRunFetchEvent[] = [
      { full: true, request: 1, type: "started" },
      { full: false, request: 2, type: "started" },
      { request: 1, type: "landed" },
    ];
    expect(
      events.reduce(auditRunFetchTransition, initialAuditRunFetch),
    ).toEqual(fetching(2, true));
  });
});
