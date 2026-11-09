import { describe, expect, it } from "bun:test";
import type { ProjectSummary } from "@balebase/validators/projects";
import {
  closedProjectListForm,
  type ProjectEditForm,
  type ProjectListForm,
  type ProjectListFormEvent,
  projectListFormTransition,
} from "./projectListFormState";

const project: ProjectSummary = {
  createdAt: "2026-10-01T00:00:00.000Z",
  description: "",
  formCount: 0,
  id: "site",
  isMember: false,
  memberCount: 0,
  name: "Site walk",
  revision: 0,
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const closed: ProjectListForm = { status: "closed" };
const adding: ProjectListForm = { status: "adding" };
const editing: ProjectEditForm = { project, status: "editing" };
const opened: ProjectListFormEvent = { project, type: "editOpened" };

describe("projectListFormTransition", () => {
  it("starts with no form", () => {
    expect(closedProjectListForm).toEqual(closed);
  });

  it.each<[string, ProjectListForm, ProjectListFormEvent, ProjectListForm]>([
    ["opens the new project form", closed, { type: "addOpened" }, adding],
    ["opens an edit", closed, opened, editing],
    ["cancels a new project", adding, { type: "cancelled" }, closed],
    ["cancels an edit", editing, { type: "cancelled" }, closed],
    [
      "closes a saved edit",
      editing,
      { form: editing, type: "editSaved" },
      closed,
    ],
  ])("%s", (_name, state, event, next) => {
    expect(projectListFormTransition(state, event)).toEqual(next);
  });

  it.each<[string, ProjectListForm, ProjectListFormEvent]>([
    ["a cancel with no form", closed, { type: "cancelled" }],
    ["a save with no form", closed, { form: editing, type: "editSaved" }],
    ["an edit over a new project", adding, opened],
    ["a second new project form", adding, { type: "addOpened" }],
    ["a save over a new project", adding, { form: editing, type: "editSaved" }],
    ["a new project over an edit", editing, { type: "addOpened" }],
    ["a second edit", editing, opened],
  ])("ignores %s", (_name, state, event) => {
    expect(projectListFormTransition(state, event)).toBe(state);
  });

  it("lets a save close only the edit it was made from", () => {
    // Cancelled while saving, then opened again: the same project, a new edit.
    const reopened = [{ type: "cancelled" } as const, opened].reduce(
      projectListFormTransition,
      editing,
    );
    expect(reopened).toEqual(editing);
    expect(
      projectListFormTransition(reopened, { form: editing, type: "editSaved" }),
    ).toBe(reopened);
  });

  it("rejects an unknown event", () => {
    expect(() =>
      projectListFormTransition(closed, { type: "unknown" } as never),
    ).toThrow("Unknown project list form event");
  });
});
