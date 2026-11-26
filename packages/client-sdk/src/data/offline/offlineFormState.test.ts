import { describe, expect, it } from "bun:test";
import type { FormTemplate } from "@balebase/validators/forms";
import type { OfflineFormState } from "@balebase/validators/offline";
import {
  answerBase,
  type FormWriteJob,
  type OfflineFormEvent,
  type OfflineFormStep,
  offlineAnswers,
  offlineFormTransition,
  own,
} from "./offlineFormState";
import type {
  LocalAnswer,
  OfflineForm,
  OfflineFormStatus,
} from "./offlineWorkspace";

const template = {
  id: "template",
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
} as FormTemplate;

const at = (minute: number) =>
  `2026-11-10T12:${String(minute).padStart(2, "0")}:00.000Z`;
/** A server answer given at `minute` by a write of version `v<minute>`. */
const stored = (value: string | null, minute: number) => ({
  at: at(minute),
  value,
  version: `v${minute}`,
});
/** An answer given here at `minute` over the server answer of `base`. */
const local = (
  value: string,
  minute: number,
  base: number | null,
): LocalAnswer => ({
  at: at(minute),
  base: base === null ? null : `v${base}`,
  value,
});

/** A form in `status` with the given layers; the server copy is in progress. */
function form(
  status: OfflineFormStatus,
  {
    server = { answers: {}, revision: 0 },
    ...layers
  }: Partial<Pick<OfflineForm, "local" | "replaced" | "sending">> & {
    server?: Omit<OfflineForm["server"], "status"> &
      Partial<Pick<OfflineForm["server"], "status">>;
  } = {},
): OfflineForm {
  return {
    id: "form",
    projectId: "project",
    startedAt: at(0),
    status,
    template,
    sending: [],
    local: {},
    replaced: {},
    ...layers,
    server: { status: "in_progress", ...server },
  };
}

function job(
  id: string,
  status: FormWriteJob["status"],
  dependsOn: string[] = [],
): FormWriteJob {
  return {
    attempts: 0,
    dependsOn,
    id,
    operation:
      id === "form"
        ? {
            answers: {},
            id,
            projectId: "project",
            templateId: "template",
            templateVersion: 2,
            type: "formStart",
          }
        : { answers: {}, formId: "form", id, type: "formSave" },
    retryAt: 0,
    status,
  };
}

function state(
  answers: OfflineFormState["answers"],
  revision: number,
  status: OfflineFormState["status"] = "in_progress",
): OfflineFormState {
  return { answers, deleted: false, id: "form", revision, status };
}

const run = (
  current: OfflineForm,
  writes: FormWriteJob[],
  event: OfflineFormEvent,
) => offlineFormTransition(current, writes, event);

describe("answering", () => {
  it.each<[string, OfflineForm, string | null]>([
    ["nothing", form("draft"), null],
    [
      "the server's answer",
      form("inProgress", {
        server: { answers: { exit: stored("na", 2) }, revision: 3 },
      }),
      "v2",
    ],
    [
      "a cleared answer",
      form("inProgress", {
        server: { answers: { exit: stored(null, 2) }, revision: 3 },
      }),
      "v2",
    ],
    [
      "an answer still being sent, which its write's ID versions",
      form("inProgress", {
        server: { answers: { exit: stored("na", 2) }, revision: 3 },
        sending: [
          {
            answers: { exit: local("fail", 3, 2) },
            completes: false,
            job: "save-1",
          },
        ],
      }),
      "save-1",
    ],
    [
      "an unsent answer, keeping its base",
      form("inProgress", { local: { exit: local("fail", 4, 1) } }),
      "v1",
    ],
  ])(
    "bases an answer given over %s on what was shown",
    (_name, current, base) => {
      expect(answerBase(current, "exit")).toBe(base);
    },
  );

  it("bases an answer to an item named like an inherited member on nothing", () => {
    const current = form("inProgress", {
      local: { exit: local("fail", 4, 1) },
      sending: [
        { answers: { exit: local("na", 3, 1) }, completes: false, job: "save" },
      ],
    });
    expect(answerBase(current, "constructor")).toBeNull();
  });

  it("shows no answer and no replaced note for an item named like an inherited member", () => {
    const current = form("inProgress", {
      replaced: { exit: { at: at(1), value: "fail" } },
    });
    expect(own(offlineAnswers(current), "constructor")).toBeUndefined();
    expect(own(current.replaced, "constructor")).toBeUndefined();
  });

  it("records an answer with the base it was given over, whatever the server copy now holds", () => {
    // The server copy changed after the person saw the answer at minute 1.
    const current = form("inProgress", {
      replaced: { exit: { at: at(1), value: "fail" } },
      server: { answers: { exit: stored("na", 4) }, revision: 4 },
    });
    const step = run(current, [], {
      at: at(5),
      base: "v1",
      itemId: "exit",
      type: "answered",
      value: "pass",
    });
    expect(step).toEqual({
      form: { ...current, local: { exit: local("pass", 5, 1) }, replaced: {} },
      queue: [],
    });
  });

  it.each<[string, OfflineForm]>([
    ["unsent", form("inProgress", { local: { exit: local("pass", 6, null) } })],
    [
      "still being sent",
      form("inProgress", {
        sending: [
          {
            answers: { exit: local("pass", 6, null) },
            completes: false,
            job: "save",
          },
        ],
      }),
    ],
  ])(
    "ignores a retried answer older than one given here since, %s",
    (_name, current) => {
      // Another tab retries the answer it failed to write at minute 4.
      const step = run(current, [job("form", "synced")], {
        at: at(4),
        base: null,
        itemId: "exit",
        type: "answered",
        value: "fail",
      });
      expect(step).toEqual({ form: current, queue: [] });
    },
  );

  it("keeps an answer written after a completion made elsewhere, and sends it for the record", () => {
    const sealed = form("completed", {
      server: { answers: {}, revision: 3, status: "completed" },
    });
    const answered = run(sealed, [job("form", "synced")], {
      at: at(5),
      base: null,
      itemId: "exit",
      type: "answered",
      value: "pass",
    });
    expect(answered.form).toMatchObject({
      local: { exit: local("pass", 5, null) },
      status: "completed",
    });
    const sent = run(answered.form, [job("form", "synced")], {
      saveId: "save",
      type: "pushed",
    });
    expect(sent.queue.map(({ operation }) => operation)).toEqual([
      {
        answers: { exit: local("pass", 5, null) },
        formId: "form",
        id: "save",
        type: "formSave",
      },
    ]);
  });
});

describe("sharing and sending", () => {
  const draft = form("draft", { local: { exit: local("pass", 4, null) } });
  const shared: OfflineFormStep = {
    form: {
      ...draft,
      local: {},
      sending: [{ answers: draft.local, completes: false, job: "form" }],
      status: "inProgress",
    },
    queue: [
      {
        ...job("form", "pending"),
        operation: {
          answers: { exit: { at: at(4), value: "pass" } },
          id: "form",
          projectId: "project",
          templateId: "template",
          templateVersion: 2,
          type: "formStart",
        },
      },
    ],
  };

  it.each<OfflineFormEvent>([{ type: "shared" }, { type: "issueRaised" }])(
    "puts a draft on the server with its answers on $type",
    (event) => {
      expect(run(draft, [], event)).toEqual(shared);
    },
  );

  it.each<[string, OfflineForm, FormWriteJob[], OfflineFormEvent]>([
    ["sharing a shared form", form("inProgress"), [], { type: "shared" }],
    [
      "an issue on a shared form",
      form("inProgress"),
      [],
      { type: "issueRaised" },
    ],
    [
      "a send with nothing to send",
      form("inProgress"),
      [job("form", "synced")],
      { saveId: "save", type: "pushed" },
    ],
    [
      "a send while a write is on its way",
      form("inProgress", { local: { exit: local("pass", 5, 1) } }),
      [job("form", "synced"), job("save-1", "pending", ["form"])],
      { saveId: "save", type: "pushed" },
    ],
    [
      "a send from a draft",
      form("draft", { local: { exit: local("pass", 5, null) } }),
      [],
      { saveId: "save", type: "pushed" },
    ],
  ])("ignores %s", (_name, current, writes, event) => {
    expect(run(current, writes, event)).toEqual({ form: current, queue: [] });
  });

  it("sends the answers given since the last write, after it", () => {
    const current = form("inProgress", {
      local: { exit: local("pass", 5, 1), notes: local("Clear", 6, null) },
    });
    const step = run(current, [job("form", "synced")], {
      saveId: "save",
      type: "pushed",
    });
    expect(step).toEqual({
      form: {
        ...current,
        local: {},
        sending: [{ answers: current.local, completes: false, job: "save" }],
      },
      queue: [
        {
          ...job("save", "pending", ["form"]),
          operation: {
            answers: current.local,
            formId: "form",
            id: "save",
            type: "formSave",
          },
        },
      ],
    });
  });
});

describe("completing", () => {
  const completion = { completedAt: at(9), startedAt: at(0) };
  const completed: OfflineFormEvent = {
    completedAt: at(9),
    saveId: "save",
    type: "completed",
  };

  it("starts and completes a draft", () => {
    const draft = form("draft", { local: { exit: local("pass", 4, null) } });
    const step = run(draft, [], completed);
    expect(step.form).toMatchObject({ local: {}, status: "completed" });
    expect(
      step.queue.map(({ dependsOn, operation }) => [operation, dependsOn]),
    ).toEqual([
      [
        {
          answers: { exit: { at: at(4), value: "pass" } },
          id: "form",
          projectId: "project",
          templateId: "template",
          templateVersion: 2,
          type: "formStart",
        },
        [],
      ],
      [
        {
          answers: {},
          formId: "form",
          completion,
          id: "save",
          type: "formSave",
        },
        ["form"],
      ],
    ]);
  });

  it("completes a shared form answered on the server, sending what is left", () => {
    const current = form("inProgress", {
      server: { answers: { exit: stored("pass", 2) }, revision: 2 },
      local: { notes: local("Clear", 6, null) },
    });
    const step = run(current, [job("form", "synced")], completed);
    expect(step.form).toMatchObject({ local: {}, status: "completed" });
    expect(step.queue).toEqual([
      {
        ...job("save", "pending", ["form"]),
        operation: {
          answers: current.local,
          formId: "form",
          completion,
          id: "save",
          type: "formSave",
        },
      },
    ]);
  });

  it.each<[string, OfflineForm]>([
    ["a draft", form("draft", { local: { notes: local("Later", 4, null) } })],
    ["a shared form", form("inProgress")],
  ])(
    "refuses to complete %s with a required item unanswered",
    (_name, current) => {
      expect(() => run(current, [job("form", "synced")], completed)).toThrow(
        "Complete every required item first.",
      );
    },
  );

  it("ignores completing a completed form", () => {
    const current = form("completed");
    expect(run(current, [], completed)).toEqual({ form: current, queue: [] });
  });
});

describe("merging the server's copy", () => {
  const sent = { exit: local("pass", 5, 1), notes: local("Clear", 5, null) };
  const sending = form("inProgress", {
    server: { answers: { exit: stored("fail", 1) }, revision: 1 },
    sending: [{ answers: sent, completes: false, job: "save" }],
  });

  it("drops a confirmed write and notes each of its answers a later one replaced", () => {
    const copy = state({ exit: stored("na", 7), notes: stored("Clear", 5) }, 3);
    const step = run(
      sending,
      [job("form", "synced"), job("save", "synced", ["form"])],
      { job: "save", state: copy, type: "confirmed" },
    );
    expect(step.form).toEqual({
      ...sending,
      replaced: { exit: { at: at(5), value: "pass" } },
      sending: [],
      server: { answers: copy.answers, revision: 3, status: "in_progress" },
    });
    expect(offlineAnswers(step.form)).toEqual({ exit: "na", notes: "Clear" });
  });

  it("notes nothing replaced that a newer copy held shows kept", () => {
    // The copy at revision 4 arrived first and shows the sent answers kept;
    // the confirmation's older copy predates them.
    const current = {
      ...sending,
      server: {
        answers: { exit: stored("pass", 5), notes: stored("Clear", 5) },
        revision: 4,
        status: "in_progress" as const,
      },
    };
    const step = run(
      current,
      [job("form", "synced"), job("save", "synced", ["form"])],
      {
        job: "save",
        state: state({ exit: stored("fail", 1) }, 3),
        type: "confirmed",
      },
    );
    expect(step.form).toEqual({ ...current, sending: [] });
  });

  it("notes nothing replaced when a newer answer from here follows", () => {
    const current = { ...sending, local: { exit: local("fail", 8, 5) } };
    const step = run(
      current,
      [job("form", "synced"), job("save", "synced", ["form"])],
      {
        job: "save",
        state: state({ exit: stored("na", 7), notes: stored("Clear", 5) }, 3),
        type: "confirmed",
      },
    );
    expect(step.form.replaced).toEqual({});
    expect(offlineAnswers(step.form)).toEqual({
      exit: "fail",
      notes: "Clear",
    });
  });

  it("opens the form again when the server did not apply its completion", () => {
    const current = form("completed", {
      server: { answers: { exit: stored("pass", 1) }, revision: 2 },
      sending: [{ answers: {}, completes: true, job: "save" }],
    });
    const step = run(
      current,
      [job("form", "synced"), job("save", "synced", ["form"])],
      {
        job: "save",
        // A required answer was cleared online after the device's.
        state: state({ exit: stored(null, 7) }, 3),
        type: "confirmed",
      },
    );
    expect(step.form).toMatchObject({ sending: [], status: "inProgress" });
    expect(offlineAnswers(step.form)).toEqual({});
  });

  it("opens the form again when a newer copy held shows it reopened after a late completion confirmation", () => {
    // The copy at revision 6, reopened online, arrived before the
    // confirmation of the completion it applied at revision 5.
    const current = form("completed", {
      server: { answers: { exit: stored("pass", 1) }, revision: 6 },
      sending: [{ answers: {}, completes: true, job: "save" }],
    });
    const step = run(
      current,
      [job("form", "synced"), job("save", "synced", ["form"])],
      {
        job: "save",
        state: state({ exit: stored("pass", 1) }, 5, "completed"),
        type: "confirmed",
      },
    );
    expect(step.form).toMatchObject({
      sending: [],
      server: { revision: 6, status: "in_progress" },
      status: "inProgress",
    });
  });

  it("keeps the newer copy it holds over an older one", () => {
    const current = form("inProgress", {
      server: { answers: { exit: stored("na", 7) }, revision: 4 },
    });
    const step = run(current, [job("form", "synced")], {
      state: state({ exit: stored("fail", 1) }, 2),
      type: "pulled",
    });
    expect(step.form).toEqual(current);
  });

  it("seals a form when a late confirmation follows a newer copy that showed it completed", () => {
    // The copy at revision 5 arrived while the save was still on its way.
    const current = form("inProgress", {
      server: { answers: {}, revision: 5, status: "completed" },
      sending: [{ answers: {}, completes: false, job: "save" }],
    });
    const step = run(
      current,
      [job("form", "synced"), job("save", "synced", ["form"])],
      { job: "save", state: state({}, 4), type: "confirmed" },
    );
    expect(step.form).toMatchObject({
      sending: [],
      server: { revision: 5 },
      status: "completed",
    });
  });

  it("shows answers given elsewhere under those still to send", () => {
    const current = form("inProgress", {
      server: { answers: { exit: stored("fail", 1) }, revision: 1 },
      local: { notes: local("Clear", 6, null) },
    });
    const step = run(current, [job("form", "synced")], {
      state: state({ exit: stored("na", 4), notes: stored("Elsewhere", 4) }, 2),
      type: "pulled",
    });
    expect(offlineAnswers(step.form)).toEqual({ exit: "na", notes: "Clear" });
    expect(step.form.status).toBe("inProgress");
  });

  it.each<[string, OfflineForm, OfflineFormStatus]>([
    ["seals a form completed elsewhere", form("inProgress"), "completed"],
    [
      "waits to seal it while answers from here are still to send",
      form("inProgress", { local: { notes: local("Clear", 6, null) } }),
      "inProgress",
    ],
  ])("%s", (_name, current, status) => {
    const step = run(current, [job("form", "synced")], {
      state: state({ exit: stored("pass", 4) }, 5, "completed"),
      type: "pulled",
    });
    expect(step.form.status).toBe(status);
  });

  it.each<[string, OfflineForm, OfflineFormStatus]>([
    [
      "opens a form sealed here when a newer copy shows it reopened",
      form("completed", {
        server: { answers: {}, revision: 5, status: "completed" },
      }),
      "inProgress",
    ],
    [
      "keeps it completed while its own completion is still on its way",
      form("completed", {
        sending: [{ answers: {}, completes: true, job: "save" }],
      }),
      "completed",
    ],
  ])("%s", (_name, current, status) => {
    const step = run(current, [job("form", "synced")], {
      state: state({ exit: stored("pass", 4) }, 6),
      type: "pulled",
    });
    expect(step.form.status).toBe(status);
  });
});
