import { describe, expect, it } from "bun:test";
import type { AuditTemplate } from "@balebase/validators/audits";
import type { OfflineAuditState } from "@balebase/validators/offline";
import {
  type AuditWriteJob,
  type OfflineAuditEvent,
  type OfflineAuditStep,
  offlineAnswers,
  offlineAuditTransition,
} from "./offlineAuditState";
import type {
  LocalAnswer,
  OfflineAudit,
  OfflineAuditStatus,
} from "./offlineStore";

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

const at = (minute: number) =>
  `2026-11-10T12:${String(minute).padStart(2, "0")}:00.000Z`;
const local = (
  value: string,
  minute: number,
  base: number | null,
): LocalAnswer => ({
  at: at(minute),
  base: base === null ? null : at(base),
  value,
});

function audit(
  status: OfflineAuditStatus,
  layers: Partial<
    Pick<OfflineAudit, "local" | "replaced" | "sending" | "server">
  > = {},
): OfflineAudit {
  return {
    id: "audit",
    projectId: "project",
    startedAt: at(0),
    status,
    template,
    server: { answers: {}, revision: 0 },
    sending: [],
    local: {},
    replaced: {},
    ...layers,
  };
}

function job(
  id: string,
  status: AuditWriteJob["status"],
  dependsOn: string[] = [],
): AuditWriteJob {
  return {
    attempts: 0,
    dependsOn,
    id,
    operation:
      id === "audit"
        ? {
            answers: {},
            id,
            projectId: "project",
            templateId: "form",
            templateVersion: 2,
            type: "auditStart",
          }
        : { answers: {}, auditId: "audit", id, type: "auditSave" },
    retryAt: 0,
    status,
  };
}

function state(
  answers: OfflineAuditState["answers"],
  revision: number,
  status: OfflineAuditState["status"] = "in_progress",
): OfflineAuditState {
  return { answers, deleted: false, id: "audit", revision, status };
}

const run = (
  current: OfflineAudit,
  writes: AuditWriteJob[],
  event: OfflineAuditEvent,
) => offlineAuditTransition(current, writes, event);

describe("answering", () => {
  it.each<[string, OfflineAudit, LocalAnswer]>([
    ["over nothing", audit("draft"), local("pass", 5, null)],
    [
      "over the server's answer",
      audit("inProgress", {
        server: { answers: { exit: { at: at(2), value: "na" } }, revision: 3 },
      }),
      local("pass", 5, 2),
    ],
    [
      "over an answer still being sent",
      audit("inProgress", {
        server: { answers: { exit: { at: at(2), value: "na" } }, revision: 3 },
        sending: [{ answers: { exit: local("fail", 3, 2) }, job: "save-1" }],
      }),
      local("pass", 5, 3),
    ],
    [
      "over an unsent answer, keeping its base",
      audit("inProgress", { local: { exit: local("fail", 4, 1) } }),
      local("pass", 5, 1),
    ],
  ])(
    "records an answer given %s with what it was given over",
    (_name, current, expected) => {
      const step = run(current, [], {
        at: at(5),
        itemId: "exit",
        type: "answered",
        value: "pass",
      });
      expect(step).toEqual({
        audit: { ...current, local: { ...current.local, exit: expected } },
        queue: [],
      });
    },
  );

  it("clears the note that a later answer replaced this one", () => {
    const current = audit("inProgress", {
      replaced: { exit: { at: at(1), value: "fail" } },
    });
    const step = run(current, [], {
      at: at(5),
      itemId: "exit",
      type: "answered",
      value: "pass",
    });
    expect(step.audit.replaced).toEqual({});
  });

  it("refuses an answer to a completed audit", () => {
    expect(() =>
      run(audit("completed"), [], {
        at: at(5),
        itemId: "exit",
        type: "answered",
        value: "pass",
      }),
    ).toThrow("This audit has been completed.");
  });
});

describe("sharing and sending", () => {
  const draft = audit("draft", { local: { exit: local("pass", 4, null) } });
  const shared: OfflineAuditStep = {
    audit: {
      ...draft,
      local: {},
      sending: [{ answers: draft.local, job: "audit" }],
      status: "inProgress",
    },
    queue: [
      {
        ...job("audit", "pending"),
        operation: {
          answers: { exit: { at: at(4), value: "pass" } },
          id: "audit",
          projectId: "project",
          templateId: "form",
          templateVersion: 2,
          type: "auditStart",
        },
      },
    ],
  };

  it.each<OfflineAuditEvent>([{ type: "shared" }, { type: "issueRaised" }])(
    "puts a draft on the server with its answers on $type",
    (event) => {
      expect(run(draft, [], event)).toEqual(shared);
    },
  );

  it.each<[string, OfflineAudit, AuditWriteJob[], OfflineAuditEvent]>([
    ["sharing a shared audit", audit("inProgress"), [], { type: "shared" }],
    [
      "an issue on a shared audit",
      audit("inProgress"),
      [],
      { type: "issueRaised" },
    ],
    [
      "a send with nothing to send",
      audit("inProgress"),
      [job("audit", "synced")],
      { saveId: "save", type: "pushed" },
    ],
    [
      "a send while a write is on its way",
      audit("inProgress", { local: { exit: local("pass", 5, 1) } }),
      [job("audit", "synced"), job("save-1", "pending", ["audit"])],
      { saveId: "save", type: "pushed" },
    ],
    [
      "a send from a draft",
      audit("draft", { local: { exit: local("pass", 5, null) } }),
      [],
      { saveId: "save", type: "pushed" },
    ],
  ])("ignores %s", (_name, current, writes, event) => {
    expect(run(current, writes, event)).toEqual({ audit: current, queue: [] });
  });

  it("sends the answers given since the last write, after it", () => {
    const current = audit("inProgress", {
      local: { exit: local("pass", 5, 1), notes: local("Clear", 6, null) },
    });
    const step = run(current, [job("audit", "synced")], {
      saveId: "save",
      type: "pushed",
    });
    expect(step).toEqual({
      audit: {
        ...current,
        local: {},
        sending: [{ answers: current.local, job: "save" }],
      },
      queue: [
        {
          ...job("save", "pending", ["audit"]),
          operation: {
            answers: current.local,
            auditId: "audit",
            id: "save",
            type: "auditSave",
          },
        },
      ],
    });
  });
});

describe("completing", () => {
  const completion = { completedAt: at(9), startedAt: at(0) };
  const completed: OfflineAuditEvent = {
    completedAt: at(9),
    saveId: "save",
    type: "completed",
  };

  it("starts and completes a draft", () => {
    const draft = audit("draft", { local: { exit: local("pass", 4, null) } });
    const step = run(draft, [], completed);
    expect(step.audit).toMatchObject({ local: {}, status: "completed" });
    expect(
      step.queue.map(({ dependsOn, operation }) => [operation, dependsOn]),
    ).toEqual([
      [
        {
          answers: { exit: { at: at(4), value: "pass" } },
          id: "audit",
          projectId: "project",
          templateId: "form",
          templateVersion: 2,
          type: "auditStart",
        },
        [],
      ],
      [
        {
          answers: {},
          auditId: "audit",
          completion,
          id: "save",
          type: "auditSave",
        },
        ["audit"],
      ],
    ]);
  });

  it("completes a shared audit answered on the server, sending what is left", () => {
    const current = audit("inProgress", {
      server: { answers: { exit: { at: at(2), value: "pass" } }, revision: 2 },
      local: { notes: local("Clear", 6, null) },
    });
    const step = run(current, [job("audit", "synced")], completed);
    expect(step.audit).toMatchObject({ local: {}, status: "completed" });
    expect(step.queue).toEqual([
      {
        ...job("save", "pending", ["audit"]),
        operation: {
          answers: current.local,
          auditId: "audit",
          completion,
          id: "save",
          type: "auditSave",
        },
      },
    ]);
  });

  it.each<[string, OfflineAudit]>([
    ["a draft", audit("draft", { local: { notes: local("Later", 4, null) } })],
    ["a shared audit", audit("inProgress")],
  ])(
    "refuses to complete %s with a required item unanswered",
    (_name, current) => {
      expect(() => run(current, [job("audit", "synced")], completed)).toThrow(
        "Complete every required item first.",
      );
    },
  );

  it("ignores completing a completed audit", () => {
    const current = audit("completed");
    expect(run(current, [], completed)).toEqual({ audit: current, queue: [] });
  });
});

describe("merging the server's copy", () => {
  const sent = { exit: local("pass", 5, 1), notes: local("Clear", 5, null) };
  const sending = audit("inProgress", {
    server: { answers: { exit: { at: at(1), value: "fail" } }, revision: 1 },
    sending: [{ answers: sent, job: "save" }],
  });

  it("drops a confirmed write and notes each of its answers a later one replaced", () => {
    const copy = state(
      {
        exit: { at: at(7), value: "na" },
        notes: { at: at(5), value: "Clear" },
      },
      3,
    );
    const step = run(
      sending,
      [job("audit", "synced"), job("save", "synced", ["audit"])],
      { job: "save", state: copy, type: "confirmed" },
    );
    expect(step.audit).toEqual({
      ...sending,
      replaced: { exit: { at: at(5), value: "pass" } },
      sending: [],
      server: { answers: copy.answers, revision: 3 },
    });
    expect(offlineAnswers(step.audit)).toEqual({ exit: "na", notes: "Clear" });
  });

  it("notes nothing replaced when a newer answer from here follows", () => {
    const current = { ...sending, local: { exit: local("fail", 8, 5) } };
    const step = run(
      current,
      [job("audit", "synced"), job("save", "synced", ["audit"])],
      {
        job: "save",
        state: state(
          {
            exit: { at: at(7), value: "na" },
            notes: { at: at(5), value: "Clear" },
          },
          3,
        ),
        type: "confirmed",
      },
    );
    expect(step.audit.replaced).toEqual({});
    expect(offlineAnswers(step.audit)).toEqual({
      exit: "fail",
      notes: "Clear",
    });
  });

  it("keeps the newer copy it holds over an older one", () => {
    const current = audit("inProgress", {
      server: { answers: { exit: { at: at(7), value: "na" } }, revision: 4 },
    });
    const step = run(current, [job("audit", "synced")], {
      state: state({ exit: { at: at(1), value: "fail" } }, 2),
      type: "pulled",
    });
    expect(step.audit).toBe(current);
  });

  it("shows answers given elsewhere under those still to send", () => {
    const current = audit("inProgress", {
      server: { answers: { exit: { at: at(1), value: "fail" } }, revision: 1 },
      local: { notes: local("Clear", 6, null) },
    });
    const step = run(current, [job("audit", "synced")], {
      state: state(
        {
          exit: { at: at(4), value: "na" },
          notes: { at: at(4), value: "Elsewhere" },
        },
        2,
      ),
      type: "pulled",
    });
    expect(offlineAnswers(step.audit)).toEqual({ exit: "na", notes: "Clear" });
    expect(step.audit.status).toBe("inProgress");
  });

  it.each<[string, OfflineAudit, OfflineAuditStatus]>([
    ["seals an audit completed elsewhere", audit("inProgress"), "completed"],
    [
      "waits to seal it while answers from here are still to send",
      audit("inProgress", { local: { notes: local("Clear", 6, null) } }),
      "inProgress",
    ],
  ])("%s", (_name, current, status) => {
    const step = run(current, [job("audit", "synced")], {
      state: state({ exit: { at: at(4), value: "pass" } }, 5, "completed"),
      type: "pulled",
    });
    expect(step.audit.status).toBe(status);
  });
});
