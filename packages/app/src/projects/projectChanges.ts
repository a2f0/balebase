import { confirmDialog } from "@balebase/ui/react";
import type { ProjectSummary } from "@balebase/validators/projects";

/**
 * Only the fields this editor changed, from the revision it loaded, so a
 * concurrent edit is refused rather than overwritten.
 */
export function editedFields(
  project: ProjectSummary,
  input: { description: string; name: string },
) {
  return {
    expectedRevision: project.revision,
    ...(input.name === project.name ? {} : { name: input.name }),
    ...(input.description === project.description
      ? {}
      : { description: input.description }),
  };
}

/** Asks before deleting a project, saying what deleting it keeps. */
export function confirmProjectDeletion(project: ProjectSummary) {
  return confirmDialog({
    confirmLabel: "Delete project",
    message:
      "Its audits stay in Audits, and a manager can restore it from Deleted projects. Members keep the forms already on their devices.",
    title: `Delete ${project.name}?`,
    tone: "danger",
  });
}
