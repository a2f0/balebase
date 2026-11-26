import type { Person } from "@balebase/validators/fields";
import type { FormTemplate } from "@balebase/validators/forms";
import type {
  OfflineFormState,
  OfflineOperation,
  OfflineProject,
  OfflineScope,
} from "@balebase/validators/offline";

/**
 * Where a form started on this device is: a `draft` only here,
 * `inProgress` once shared with the server (by writes that may not have
 * synced yet), or `completed`: sealed, here or on the server.
 * `offlineFormState.ts` moves it between them.
 */
export type OfflineFormStatus = "draft" | "inProgress" | "completed";

/** An answer and the UTC time it was given. */
export interface AnswerWrite {
  at: string;
  value: string;
}

/**
 * An answer given on this device, and `base`: the version of the server's
 * answer it was given over (null when the server had none), which tells the
 * server whether someone else answered in between.
 */
export interface LocalAnswer extends AnswerWrite {
  base: string | null;
}

/**
 * A form started on this device. It keeps the template version it was started
 * from, so it can be finished and synced after the template is unpublished,
 * edited, or turned off for its project.
 *
 * Its answers are three layers, later over earlier: `server`, the server's
 * answers as last read; `sending`, those in writes the server has not
 * confirmed yet; and `local`, those no write carries yet.
 */
export interface OfflineForm {
  id: string;
  projectId: string;
  startedAt: string;
  template: FormTemplate;
  status: OfflineFormStatus;
  server: Pick<OfflineFormState, "answers" | "revision" | "status">;
  /** Writes the server has not confirmed yet; `completes` marks a completion. */
  sending: {
    answers: Record<string, LocalAnswer>;
    completes: boolean;
    job: string;
  }[];
  local: Record<string, LocalAnswer>;
  /** Answers given here that the server did not keep. */
  replaced: Record<string, AnswerWrite>;
}

interface OfflineIssue {
  operation: Extract<OfflineOperation, { type: "issue" }>;
  images: { id: string; filename: string }[];
}

export interface OfflineJob {
  id: string;
  dependsOn: string[];
  operation:
    | OfflineOperation
    | { type: "image"; issueId: string; id: string; filename: string };
  status: "pending" | "blocked" | "synced";
  attempts: number;
  retryAt: number;
  error?: string;
}

/** A job for `operation`, sent once the jobs it depends on have synced. */
export function pendingJob<Operation extends OfflineJob["operation"]>(
  operation: Operation,
  dependsOn: string[],
): OfflineJob & { operation: Operation } {
  return {
    id: operation.id,
    operation,
    dependsOn,
    status: "pending",
    attempts: 0,
    retryAt: 0,
  };
}

/** Who offline work belongs to, and the organization it was prepared in. */
export interface OfflineIdentity {
  scope: OfflineScope;
  user: Person;
  organizationName: string;
}

/**
 * What this device keeps for one person in one organization: what the last
 * sync read (`projects`, `templates`, `members`, as of `cursor`), and the work
 * done here (`forms`, `issues`, and the `jobs` that sync them).
 */
export interface OfflineWorkspace extends OfflineIdentity {
  key: string;
  /** The server cursor the synced data is as of; none before a first sync. */
  cursor?: string | undefined;
  projects: OfflineProject[];
  /** The published templates of `projects`, by template ID. */
  templates: FormTemplate[];
  members: Person[];
  forms: OfflineForm[];
  issues: OfflineIssue[];
  jobs: OfflineJob[];
}
