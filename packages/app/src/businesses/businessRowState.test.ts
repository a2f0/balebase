import { describe, expect, it } from "bun:test";
import {
  type BusinessRowEvent,
  type BusinessRowState,
  businessRowTransition,
  initialBusinessRow,
} from "./businessRowState";

const viewing: BusinessRowState = { status: "viewing" };
const editing: BusinessRowState = { status: "editing" };
const deleting: BusinessRowState = { status: "deleting" };

function run(state: BusinessRowState, ...events: BusinessRowEvent[]) {
  return events.reduce(businessRowTransition, state);
}

describe("businessRowTransition", () => {
  it("starts on the summary", () => {
    expect(initialBusinessRow).toEqual(viewing);
  });

  it.each<[string, BusinessRowState, BusinessRowEvent, BusinessRowState]>([
    ["opens the editor", viewing, { type: "editOpened" }, editing],
    ["closes the editor", editing, { type: "editClosed" }, viewing],
    ["starts a delete", viewing, { type: "deleteStarted" }, deleting],
    [
      "returns after a failed delete",
      deleting,
      { type: "deleteFailed" },
      viewing,
    ],
  ])("%s", (_name, state, event, next) => {
    expect(businessRowTransition(state, event)).toEqual(next);
  });

  it.each<[string, BusinessRowState, BusinessRowEvent]>([
    ["a close with no editor", viewing, { type: "editClosed" }],
    ["a failure with no delete", viewing, { type: "deleteFailed" }],
    ["a second editor", editing, { type: "editOpened" }],
    ["a delete from the editor", editing, { type: "deleteStarted" }],
    ["a failure while editing", editing, { type: "deleteFailed" }],
    ["the editor over a delete", deleting, { type: "editOpened" }],
    ["a second delete", deleting, { type: "deleteStarted" }],
    ["a close during a delete", deleting, { type: "editClosed" }],
  ])("ignores %s", (_name, state, event) => {
    expect(businessRowTransition(state, event)).toBe(state);
  });

  it("never edits and deletes at once", () => {
    // The old pair of booleans could hold editing && busy.
    expect(
      run(viewing, { type: "deleteStarted" }, { type: "editOpened" }),
    ).toEqual(deleting);
    expect(
      run(viewing, { type: "editOpened" }, { type: "deleteStarted" }),
    ).toEqual(editing);
  });

  it("can edit again after a failed delete", () => {
    expect(
      run(
        viewing,
        { type: "deleteStarted" },
        { type: "deleteFailed" },
        { type: "editOpened" },
      ),
    ).toEqual(editing);
  });

  it("rejects an unknown event", () => {
    expect(() =>
      businessRowTransition(viewing, { type: "unknown" } as never),
    ).toThrow("Unknown business row event");
  });
});
