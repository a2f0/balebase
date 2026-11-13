import { describe, expect, it } from "bun:test";
import {
  type AuthoringState,
  authoringInitialState,
  authoringReducer,
} from "./contractAuthoringState";
import {
  type ContractPdfEvent,
  type ContractPdfState,
  contractPdfReducer,
  recordRenderedPage,
} from "./contractPdfState";

const loading: ContractPdfState<string> = { status: "loading", request: 1 };
const loaded: ContractPdfState<string> = {
  status: "loaded",
  request: 1,
  document: "PDF",
};
const failed: ContractPdfState<string> = { status: "failed", request: 1 };

describe("contract PDF lifecycle", () => {
  it.each([
    [loading, { type: "loaded", request: 1, document: "PDF" }, loaded],
    [loading, { type: "failed", request: 1 }, failed],
    [loaded, { type: "failed", request: 1 }, failed],
    [failed, { type: "loaded", request: 1, document: "PDF" }, failed],
    [failed, { type: "failed", request: 1 }, failed],
  ] satisfies [
    ContractPdfState<string>,
    ContractPdfEvent<string>,
    ContractPdfState<string>,
  ][])("%o handles %o", (state, event, expected) => {
    expect(contractPdfReducer(state, event)).toEqual(expected);
  });

  it("ignores stale success and failure after a replacement load", () => {
    const replacement = contractPdfReducer(loading, {
      type: "start",
      request: 2,
    });
    expect(
      contractPdfReducer(replacement, {
        type: "loaded",
        request: 1,
        document: "stale",
      }),
    ).toBe(replacement);
    expect(
      contractPdfReducer(replacement, {
        type: "failed",
        request: 1,
      }),
    ).toBe(replacement);
    expect(
      contractPdfReducer(replacement, {
        type: "loaded",
        request: 2,
        document: "current",
      }),
    ).toEqual({ status: "loaded", request: 2, document: "current" });
  });

  it("permits retry after loading or rendering fails", () => {
    const retry = contractPdfReducer(failed, { type: "start", request: 2 });
    expect(retry).toEqual({ status: "loading", request: 2 });
    expect(
      contractPdfReducer(retry, {
        type: "loaded",
        request: 2,
        document: "retry",
      }).status,
    ).toBe("loaded");
  });
});

describe("authored PDF review readiness", () => {
  it("requires every distinct page, including pages rendered out of order", () => {
    const rendered = new Set<number>();
    expect(recordRenderedPage(rendered, 3, 3)).toBe(false);
    expect(recordRenderedPage(rendered, 1, 3)).toBe(false);
    expect(recordRenderedPage(rendered, 3, 3)).toBe(false);
    expect(recordRenderedPage(rendered, 2, 3)).toBe(true);
    expect(recordRenderedPage(rendered, 2, 3)).toBe(false);
  });

  it("does not count invalid pages or empty documents as reviewed", () => {
    const rendered = new Set<number>();
    for (const page of [0, -1, 4, 1.5, Number.NaN]) {
      expect(recordRenderedPage(rendered, page, 3)).toBe(false);
    }
    expect(rendered.size).toBe(0);
    expect(recordRenderedPage(rendered, 1, 0)).toBe(false);
    expect(recordRenderedPage(rendered, 1, 1)).toBe(true);
  });
});

it("keeps review disabled until all pages render and exposes current PDF failures", () => {
  let state: AuthoringState = {
    ...authoringInitialState(),
    status: "renderingPreview",
    request: 2,
    bytes: new ArrayBuffer(8),
  };
  const rendered = new Set<number>();
  expect(authoringReducer(state, { type: "review", request: 2 })).toBe(state);
  expect(recordRenderedPage(rendered, 1, 2)).toBe(false);
  expect(
    authoringReducer(state, {
      type: "failed",
      request: 1,
      message: "Stale failure",
    }),
  ).toBe(state);
  expect(
    authoringReducer(state, {
      type: "failed",
      request: 2,
      message: "Cannot render PDF",
    }),
  ).toMatchObject({ status: "editing", error: "Cannot render PDF" });
  if (recordRenderedPage(rendered, 2, 2)) {
    state = authoringReducer(state, { type: "displayed", request: 2 });
  }
  expect(state.status).toBe("preview");
  expect(authoringReducer(state, { type: "review", request: 2 }).status).toBe(
    "reviewed",
  );
});
