import { describe, expect, it } from "bun:test";
import type { ContractDetail } from "@balebase/validators/contracts";
import {
  type AuthoringEvent,
  type AuthoringState,
  authoringDirty,
  authoringInitialState,
  authoringReducer,
  newAuthoredDraft,
} from "./contractAuthoringState";

function saved(revision = 1): ContractDetail {
  return {
    authoring: { ...newAuthoredDraft(), revision },
    completedAt: null,
    createdAt: "2026-11-01T12:00:00Z",
    createdByName: "Owner",
    document: {
      filename: "agreement.pdf",
      pageCount: 1,
      sha256: "abc",
      size: 800,
    },
    dueDate: null,
    events: [],
    fields: [],
    finalSha256: null,
    id: "authored-1",
    message: "",
    recipients: [],
    reminderIntervalDays: null,
    sentAt: null,
    sentByName: null,
    signingOrder: "parallel",
    status: "draft",
    template: null,
    title: "Agreement",
    updatedAt: "2026-11-01T12:00:00Z",
    voidReason: null,
    voidedAt: null,
  };
}

function reviewed(): AuthoringState {
  const events: AuthoringEvent[] = [
    { request: 1, type: "preview" },
    { bytes: new ArrayBuffer(8), request: 1, type: "loadedPreview" },
    { request: 1, type: "displayed" },
    { request: 1, type: "review" },
  ];
  return events.reduce(authoringReducer, authoringInitialState(saved()));
}

describe("written contract lifecycle", () => {
  it("requires loaded pages and explicit review of the saved revision before send", () => {
    let state = authoringInitialState(saved(7));
    expect(authoringDirty(state)).toBe(false);
    expect(authoringReducer(state, { request: 2, type: "send" })).toBe(state);
    state = authoringReducer(state, { request: 3, type: "preview" });
    state = authoringReducer(state, {
      bytes: new ArrayBuffer(8),
      request: 3,
      type: "loadedPreview",
    });
    expect(authoringReducer(state, { request: 3, type: "review" })).toBe(state);
    state = authoringReducer(state, { request: 3, type: "displayed" });
    state = authoringReducer(state, { request: 3, type: "review" });
    state = authoringReducer(state, { request: 4, type: "send" });
    expect(state.status).toBe("sending");
    expect(state.saved?.authoring?.revision).toBe(7);
  });

  it.each([
    "source",
    "title",
    "values",
    "recipients",
    "message",
    "dueDate",
    "reminderIntervalDays",
    "signingOrder",
  ] as const)("invalidates the preview after editing %s", (key) => {
    const state = reviewed();
    const changes = {
      source: "Changed",
      title: "New title",
      values: { price: "20" },
      recipients: [],
      message: "New message",
      dueDate: "2027-01-01",
      reminderIntervalDays: 3,
      signingOrder: "sequential" as const,
    };
    const edited = authoringReducer(state, {
      draft: { ...state.draft, [key]: changes[key] },
      type: "edit",
    });
    expect(edited.status).toBe("editing");
    expect(authoringDirty(edited)).toBe(true);
    expect("bytes" in edited).toBe(false);
    expect(authoringReducer(edited, { request: 2, type: "send" })).toBe(edited);
    expect(authoringReducer(edited, { request: 2, type: "preview" })).toBe(
      edited,
    );
  });

  it("rejects stale save success and failure across a retry", () => {
    let state = authoringReducer(authoringInitialState(), {
      request: 1,
      type: "save",
    });
    const source = state.draft.source;
    state = authoringReducer(state, {
      message: "Conflict",
      request: 1,
      type: "failed",
    });
    expect(state.draft.source).toBe(source);
    state = authoringReducer(state, { request: 2, type: "save" });
    expect(
      authoringReducer(state, {
        contract: saved(1),
        request: 1,
        type: "saved",
      }),
    ).toBe(state);
    expect(
      authoringReducer(state, {
        message: "Late failure",
        request: 1,
        type: "failed",
      }),
    ).toBe(state);
    state = authoringReducer(state, {
      contract: saved(2),
      request: 2,
      type: "saved",
    });
    expect(state.status).toBe("loadingPreview");
    expect(state.saved?.authoring?.revision).toBe(2);
    expect(authoringDirty(state)).toBe(false);
  });

  it("ignores stale preview and review events after an edit and replacement preview", () => {
    const state = reviewed();
    const edited = authoringReducer(state, {
      draft: { ...state.draft, source: "Revision two" },
      type: "edit",
    });
    expect(authoringReducer(edited, { request: 1, type: "displayed" })).toBe(
      edited,
    );
    let next = authoringReducer(edited, { request: 2, type: "save" });
    next = authoringReducer(next, {
      contract: saved(2),
      request: 2,
      type: "saved",
    });
    expect(
      authoringReducer(next, {
        bytes: new ArrayBuffer(4),
        request: 1,
        type: "loadedPreview",
      }),
    ).toBe(next);
    expect(authoringReducer(next, { request: 1, type: "review" })).toBe(next);
  });

  it("does not start a second mutation or accept edits while a mutation is running", () => {
    const state = authoringReducer(reviewed(), { request: 2, type: "send" });
    for (const type of ["save", "send", "delete", "preview"] as const) {
      expect(authoringReducer(state, { request: 3, type })).toBe(state);
    }
    expect(
      authoringReducer(state, { draft: newAuthoredDraft(), type: "edit" }),
    ).toBe(state);
  });

  it("deletes a local draft without requiring a persisted contract", () => {
    let state = authoringReducer(authoringInitialState(), {
      request: 1,
      type: "delete",
    });
    state = authoringReducer(state, { request: 1, type: "deleted" });
    expect(state.status).toBe("deleted");
    expect(authoringDirty(state)).toBe(false);
  });
});
