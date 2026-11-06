import { describe, expect, it } from "bun:test";
import {
  type FinanceStartEvent,
  type FinanceStartState,
  financeStartTransition,
  initialFinanceStart,
  shownFinanceStart,
} from "./financeStartState";

const saving = (request: number, value: boolean): FinanceStartState => ({
  request,
  status: "saving",
  value,
});

describe("Finance start state", () => {
  it.each<[string, FinanceStartState, FinanceStartEvent, FinanceStartState]>([
    [
      "starts a save",
      initialFinanceStart,
      { request: 1, type: "saveStarted", value: true },
      saving(1, true),
    ],
    [
      "starts again after a failure",
      { message: "x", status: "failed" },
      { request: 2, type: "saveStarted", value: false },
      saving(2, false),
    ],
    [
      "ignores a second start while saving",
      saving(1, true),
      { request: 2, type: "saveStarted", value: false },
      saving(1, true),
    ],
    [
      "finishes its own save",
      saving(1, true),
      { request: 1, type: "saveFinished" },
      initialFinanceStart,
    ],
    [
      "fails its own save",
      saving(1, true),
      { message: "No", request: 1, type: "saveFailed" },
      { message: "No", status: "failed" },
    ],
    [
      "ignores another save's finish",
      saving(2, true),
      { request: 1, type: "saveFinished" },
      saving(2, true),
    ],
    [
      "ignores another save's failure",
      saving(2, true),
      { message: "No", request: 1, type: "saveFailed" },
      saving(2, true),
    ],
    [
      "ignores a finish when idle",
      initialFinanceStart,
      { request: 1, type: "saveFinished" },
      initialFinanceStart,
    ],
  ])("%s", (_name, state, event, next) => {
    expect(financeStartTransition(state, event)).toEqual(next);
  });

  it("shows the value being saved, else the saved one", () => {
    expect(shownFinanceStart(saving(1, true), false)).toBe(true);
    expect(shownFinanceStart(initialFinanceStart, false)).toBe(false);
    expect(shownFinanceStart({ message: "x", status: "failed" }, true)).toBe(
      true,
    );
  });
});
