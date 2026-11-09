import type { ProjectSummary } from "@balebase/validators/projects";

/** An edit of one listed project, open above the list. */
export interface ProjectEditForm {
  project: ProjectSummary;
  status: "editing";
}

/**
 * The form open above the project list: none, a new project, or an edit of
 * one project, never two at once. Each edit opened is a state of its own, so
 * a save closes only the edit it was made from, never one opened after it
 * was cancelled.
 */
export type ProjectListForm =
  | { status: "closed" }
  | { status: "adding" }
  | ProjectEditForm;

export type ProjectListFormEvent =
  | { type: "addOpened" }
  | { project: ProjectSummary; type: "editOpened" }
  | { type: "cancelled" }
  /** `form` saved; a refused save sends nothing and keeps it open. */
  | { form: ProjectEditForm; type: "editSaved" };

export const closedProjectListForm: ProjectListForm = { status: "closed" };

/**
 * The list form's transitions. A form opens only over none; events that do
 * not apply leave the state unchanged. Creating a project needs no event: it
 * opens the new project's page.
 */
export function projectListFormTransition(
  state: ProjectListForm,
  event: ProjectListFormEvent,
): ProjectListForm {
  switch (event.type) {
    case "addOpened":
      return state.status === "closed" ? { status: "adding" } : state;
    case "editOpened":
      return state.status === "closed"
        ? { project: event.project, status: "editing" }
        : state;
    case "cancelled":
      return state.status === "closed" ? state : closedProjectListForm;
    case "editSaved":
      return state === event.form ? closedProjectListForm : state;
    default:
      return unknownEvent(event);
  }
}

function unknownEvent(event: never): never {
  throw new Error(`Unknown project list form event: ${JSON.stringify(event)}`);
}
