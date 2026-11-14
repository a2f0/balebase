import { describe, expect, it } from "bun:test";
import { newAuthoredDraft } from "./contractAuthoringState";
import { writtenTemplateInput } from "./contractTemplateAuthoring";
import {
  type TemplateRequestEvent,
  type TemplateRequestState,
  templateRequestReducer,
} from "./contractTemplateState";

const run = async () => "saved";
const idle: TemplateRequestState<string> = { status: "idle" };

describe("template request lifecycle", () => {
  const first = { status: "pending", request: 1, run } as const;
  const second = { status: "pending", request: 2, run } as const;
  const failure = {
    status: "failed",
    request: 1,
    error: "Conflict; edits kept",
  } as const;
  const success = { status: "succeeded", request: 2, result: "saved" } as const;
  const cases: [
    string,
    TemplateRequestState<string>,
    TemplateRequestEvent<string>,
    TemplateRequestState<string>,
  ][] = [
    ["starts from idle", idle, { type: "start", request: 1, run }, first],
    [
      "ignores duplicate starts",
      first,
      { type: "start", request: 2, run },
      first,
    ],
    ["resets an active request", first, { type: "reset" }, idle],
    [
      "ignores success after reset",
      idle,
      { type: "succeeded", request: 1, result: "late" },
      idle,
    ],
    [
      "ignores failure after reset",
      idle,
      { type: "failed", request: 1, error: "late" },
      idle,
    ],
    [
      "ignores stale success during a new request",
      second,
      { type: "succeeded", request: 1, result: "old" },
      second,
    ],
    [
      "ignores stale failure during a new request",
      second,
      { type: "failed", request: 1, error: "old" },
      second,
    ],
    [
      "accepts the current success",
      second,
      { type: "succeeded", request: 2, result: "saved" },
      success,
    ],
    [
      "keeps the current failure",
      first,
      { type: "failed", request: 1, error: "Conflict; edits kept" },
      failure,
    ],
    [
      "retries after failure",
      failure,
      { type: "start", request: 2, run },
      second,
    ],
    [
      "ignores replayed failure after success",
      success,
      { type: "failed", request: 2, error: "late" },
      success,
    ],
    ["clears a failure", failure, { type: "reset" }, idle],
    ["resets a completed request", success, { type: "reset" }, idle],
  ];
  it.each(cases)("%s", (_name, state, event, expected) => {
    expect(templateRequestReducer(state, event)).toEqual(expected);
  });
});

describe("written contract conversion", () => {
  it("copies source and literal defaults, never identities or due date", () => {
    const draft = {
      ...newAuthoredDraft(),
      dueDate: "2027-01-01",
      recipients: [
        {
          key: "client",
          name: "Private Name",
          email: "private@example.com",
          routingOrder: 2,
        },
      ],
      values: {
        "project.title": "Literal **not markdown**",
        "client.name": "Private Name",
        "client.email": "private@example.com",
      },
    };
    const original = structuredClone(draft);
    const input = writtenTemplateInput(draft, "Reusable agreement");
    expect(input.authoring.source).toBe(draft.source);
    expect(input.authoring.values).toEqual({
      "project.title": "Literal **not markdown**",
    });
    expect(input.definition.roles).toEqual([
      { key: "client", label: "Client", routingOrder: 2 },
    ]);
    expect(input.definition.fields).toEqual([]);
    expect(input).not.toHaveProperty("dueDate");
    expect(input).not.toHaveProperty("recipients");
    expect(JSON.stringify(input)).not.toContain("Private Name");
    expect(JSON.stringify(input)).not.toContain("private@example.com");
    expect(draft).toEqual(original);
  });
});
