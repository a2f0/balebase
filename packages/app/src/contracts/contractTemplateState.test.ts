import { describe, expect, it } from "bun:test";
import { newAuthoredDraft } from "./contractAuthoringState";
import { writtenTemplateInput } from "./contractTemplateAuthoring";
import {
  type TemplateRequestState,
  templateRequestReducer,
} from "./contractTemplateState";

const run = async () => "saved";
const idle: TemplateRequestState<string> = { status: "idle" };

describe("template request lifecycle", () => {
  it("accepts one request and ignores a duplicate start", () => {
    const pending = templateRequestReducer(idle, {
      type: "start",
      request: 1,
      run,
    });
    expect(pending.status).toBe("pending");
    expect(
      templateRequestReducer(pending, { type: "start", request: 2, run }),
    ).toBe(pending);
  });

  it("ignores completion A after reset and start B", () => {
    const first = templateRequestReducer(idle, {
      type: "start",
      request: 1,
      run,
    });
    const reset = templateRequestReducer(first, { type: "reset" });
    const second = templateRequestReducer(reset, {
      type: "start",
      request: 2,
      run,
    });
    expect(
      templateRequestReducer(second, {
        type: "succeeded",
        request: 1,
        result: "old",
      }),
    ).toBe(second);
    expect(
      templateRequestReducer(second, {
        type: "failed",
        request: 1,
        error: "old error",
      }),
    ).toBe(second);
    expect(
      templateRequestReducer(second, {
        type: "succeeded",
        request: 2,
        result: "new",
      }),
    ).toEqual({ status: "succeeded", request: 2, result: "new" });
  });

  it("can retry a failure and rejects a replayed failure after success", () => {
    const first = templateRequestReducer(idle, {
      type: "start",
      request: 1,
      run,
    });
    const failure = templateRequestReducer(first, {
      type: "failed",
      request: 1,
      error: "Conflict; edits kept",
    });
    expect(failure).toEqual({
      status: "failed",
      request: 1,
      error: "Conflict; edits kept",
    });
    const retry = templateRequestReducer(failure, {
      type: "start",
      request: 2,
      run,
    });
    const success = templateRequestReducer(retry, {
      type: "succeeded",
      request: 2,
      result: "saved",
    });
    expect(
      templateRequestReducer(success, {
        type: "failed",
        request: 2,
        error: "late",
      }),
    ).toBe(success);
    expect(
      templateRequestReducer(idle, {
        type: "succeeded",
        request: 1,
        result: "late",
      }),
    ).toBe(idle);
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
      { key: "client", label: "client", routingOrder: 2 },
    ]);
    expect(input.definition.fields).toEqual([]);
    expect(input).not.toHaveProperty("dueDate");
    expect(input).not.toHaveProperty("recipients");
    expect(JSON.stringify(input)).not.toContain("Private Name");
    expect(JSON.stringify(input)).not.toContain("private@example.com");
    expect(draft).toEqual(original);
  });
});
