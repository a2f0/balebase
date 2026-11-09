import { describe, expect, it } from "bun:test";
import type { AuditTemplate } from "@balebase/validators/audits";
import {
  type AuditWriteJob,
  type OfflineAuditEvent,
  type OfflineAuditStep,
  offlineAuditTransition,
} from "./offlineAuditState";
import type { OfflineAudit, OfflineAuditStatus } from "./offlineStore";

type Case = [
  string,
  OfflineAudit,
  AuditWriteJob[],
  OfflineAuditEvent,
  OfflineAuditStep,
];

const template = {
  id: "form",
  version: 2,
  definition: {
    version: 1,
    sections: [
      {
        id: "section",
        title: "Site",
        items: [
          {
            id: "exit",
            prompt: "Exit clear?",
            required: true,
            responseType: "check",
          },
          {
            id: "notes",
            prompt: "Notes",
            required: false,
            responseType: "text",
          },
        ],
      },
    ],
  },
} as AuditTemplate;

function audit(
  status: OfflineAuditStatus,
  responses: Record<string, string> = { exit: "pass" },
): OfflineAudit {
  return {
    id: "audit",
    projectId: "project",
    responses,
    startedAt: "2026-11-09T12:00:00.000Z",
    status,
    template,
  };
}

const start: AuditWriteJob = {
  attempts: 0,
  dependsOn: [],
  id: "audit",
  operation: {
    id: "audit",
    projectId: "project",
    responses: { exit: "fail" },
    templateId: "form",
    templateVersion: 2,
    type: "auditStart",
  },
  retryAt: 0,
  status: "synced",
};
const answered: OfflineAuditEvent = {
  itemId: "notes",
  type: "answered",
  value: "Clear",
};
const progress: OfflineAuditEvent = { saveId: "save", type: "progressSaved" };
const issue: OfflineAuditEvent = { type: "issueRaised" };
const completed: OfflineAuditEvent = {
  completedAt: "2026-11-09T12:30:00.000Z",
  saveId: "save",
  type: "completed",
};
const completion = {
  startedAt: "2026-11-09T12:00:00.000Z",
  completedAt: "2026-11-09T12:30:00.000Z",
};

/** The pending write that puts the audit on the server with `responses`. */
function startOf(responses: Record<string, string>): AuditWriteJob {
  return {
    attempts: 0,
    dependsOn: [],
    id: "audit",
    operation: {
      id: "audit",
      type: "auditStart",
      projectId: "project",
      templateId: "form",
      templateVersion: 2,
      responses,
    },
    retryAt: 0,
    status: "pending",
  };
}

/** The pending save over `expectedRevision`, after `after`. */
function saveOf(
  expectedRevision: number,
  after: string,
  extra: { completion?: typeof completion } = {},
): AuditWriteJob {
  return {
    attempts: 0,
    dependsOn: [after],
    id: "save",
    operation: {
      id: "save",
      type: "auditSave",
      auditId: "audit",
      expectedRevision,
      responses: { exit: "pass" },
      ...extra,
    },
    retryAt: 0,
    status: "pending",
  };
}

describe("offlineAuditTransition", () => {
  it.each<Case>([
    [
      "keeps a draft's answer on the device",
      audit("draft"),
      [],
      answered,
      {
        audit: audit("draft", { exit: "pass", notes: "Clear" }),
        queue: [],
      },
    ],
    [
      "puts a draft on the server when its progress is saved",
      audit("draft"),
      [],
      progress,
      { audit: audit("inProgress"), queue: [startOf({ exit: "pass" })] },
    ],
    [
      "puts a draft on the server when an issue is raised on it",
      audit("draft"),
      [],
      issue,
      { audit: audit("inProgress"), queue: [startOf({ exit: "pass" })] },
    ],
    [
      "starts and completes a draft in one step",
      audit("draft"),
      [],
      completed,
      {
        audit: audit("completed"),
        queue: [startOf({ exit: "pass" }), saveOf(1, "audit", { completion })],
      },
    ],
    [
      "keeps an in-progress audit's answer on the device",
      audit("inProgress"),
      [start],
      answered,
      {
        audit: audit("inProgress", { exit: "pass", notes: "Clear" }),
        queue: [],
      },
    ],
    [
      "saves changed answers over the last write's revision",
      audit("inProgress"),
      [start],
      progress,
      { audit: audit("inProgress"), queue: [saveOf(1, "audit")] },
    ],
    [
      "saves nothing when the answers are those last written",
      audit("inProgress", { exit: "fail" }),
      [start],
      progress,
      { audit: audit("inProgress", { exit: "fail" }), queue: [] },
    ],
    [
      "queues nothing more for an issue on an audit already started",
      audit("inProgress"),
      [start],
      issue,
      { audit: audit("inProgress"), queue: [] },
    ],
    [
      "completes an in-progress audit with one save",
      audit("inProgress"),
      [start],
      completed,
      {
        audit: audit("completed"),
        queue: [saveOf(1, "audit", { completion })],
      },
    ],
    ...[progress, issue, completed].map(
      (event): Case => [
        `ignores ${event.type} once completed`,
        audit("completed"),
        [start],
        event,
        { audit: audit("completed"), queue: [] },
      ],
    ),
  ])("%s", (_name, current, writes, event, next) => {
    expect(offlineAuditTransition(current, writes, event)).toEqual(next);
  });

  it("expects one more revision for each write already queued", () => {
    const firstSave: AuditWriteJob = {
      ...start,
      dependsOn: ["audit"],
      id: "first-save",
      operation: {
        auditId: "audit",
        expectedRevision: 1,
        id: "first-save",
        responses: { exit: "fail" },
        type: "auditSave",
      },
    };
    const step = offlineAuditTransition(
      audit("inProgress"),
      [start, firstSave],
      progress,
    );
    expect(step.queue).toEqual([saveOf(2, "first-save")]);
  });

  it.each<[string, OfflineAudit, OfflineAuditEvent, string]>([
    [
      "an answer to a completed audit",
      audit("completed"),
      answered,
      "This audit has been completed.",
    ],
    [
      "completing a draft with a required item unanswered",
      audit("draft", {}),
      completed,
      "Complete every required item first.",
    ],
    [
      "completing an in-progress audit with a required item unanswered",
      audit("inProgress", { notes: "Later" }),
      completed,
      "Complete every required item first.",
    ],
  ])("refuses %s", (_name, current, event, message) => {
    expect(() => offlineAuditTransition(current, [start], event)).toThrow(
      message,
    );
  });
});
