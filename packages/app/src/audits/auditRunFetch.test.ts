import { describe, expect, it } from "bun:test";
import {
  type AuditRunFetch,
  type AuditRunFetchEvent,
  auditRunFetchTransition,
  initialAuditRunFetch,
} from "./auditRunFetch";

const kept = { keepSince: { exit: "pass" } };
const reloadOf = (full: boolean) => (full ? kept : null);
const fetching = (request: number, full: boolean): AuditRunFetch => ({
  reload: reloadOf(full),
  request,
  status: "fetching",
});
const failed = (full: boolean): AuditRunFetch => ({
  message: "Try again.",
  reload: reloadOf(full),
  status: "failed",
});

describe("audit run fetch", () => {
  it.each<[string, AuditRunFetch, AuditRunFetchEvent, AuditRunFetch]>([
    [
      "starts a full read",
      initialAuditRunFetch,
      { reload: kept, request: 1, type: "started" },
      fetching(1, true),
    ],
    [
      "starts an issues read",
      initialAuditRunFetch,
      { reload: null, request: 1, type: "started" },
      fetching(1, false),
    ],
    [
      "keeps a replaced full read full",
      fetching(1, true),
      { reload: null, request: 2, type: "started" },
      fetching(2, true),
    ],
    [
      "upgrades a replaced issues read",
      fetching(1, false),
      { reload: kept, request: 2, type: "started" },
      fetching(2, true),
    ],
    [
      "keeps a failed full read full",
      failed(true),
      { reload: null, request: 2, type: "started" },
      fetching(2, true),
    ],
    [
      "reads issues after a failed issues read",
      failed(false),
      { reload: null, request: 2, type: "started" },
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

  it("lets a newer reload's choice win over a pending one", () => {
    expect(
      auditRunFetchTransition(fetching(1, true), {
        reload: {},
        request: 2,
        type: "started",
      }),
    ).toEqual({ reload: {}, request: 2, status: "fetching" });
  });

  it("lets only the newest read land, still full", () => {
    const events: AuditRunFetchEvent[] = [
      { reload: kept, request: 1, type: "started" },
      { reload: null, request: 2, type: "started" },
      { request: 1, type: "landed" },
    ];
    expect(
      events.reduce(auditRunFetchTransition, initialAuditRunFetch),
    ).toEqual(fetching(2, true));
  });
});
