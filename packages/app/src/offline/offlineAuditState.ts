import type { OfflineOperation } from "@balebase/validators/offline";
import { progressFor } from "../audits/auditProgress";
import { type OfflineAudit, type OfflineJob, pendingJob } from "./offlineStore";

type AuditWrite = Extract<
  OfflineOperation,
  { type: "auditStart" } | { type: "auditSave" }
>;

/** A queued server write of an audit: its start, or a save. */
export type AuditWriteJob = OfflineJob & { operation: AuditWrite };

/**
 * What happens to an audit on this device. The caller supplies new IDs and
 * times, so the transition stays pure.
 */
export type OfflineAuditEvent =
  | { itemId: string; type: "answered"; value: string }
  /** Save the answers so far to the server, as an in-progress audit. */
  | { saveId: string; type: "progressSaved" }
  /** An issue was raised on one of its items; the issue needs it on the server. */
  | { type: "issueRaised" }
  | { completedAt: string; saveId: string; type: "completed" };

/** The audit after an event, and the server writes the event queues. */
export interface OfflineAuditStep {
  audit: OfflineAudit;
  queue: AuditWriteJob[];
}

/**
 * The audit's queued server writes, oldest first: its start, then each save.
 * Each raises the server's revision by one, so a save expects as many
 * writes before it.
 */
export function auditWrites(jobs: OfflineJob[], auditId: string) {
  return jobs.filter(
    (job): job is AuditWriteJob =>
      (job.operation.type === "auditStart" && job.operation.id === auditId) ||
      (job.operation.type === "auditSave" && job.operation.auditId === auditId),
  );
}

/** Whether the answers differ from those the last server write carries. */
export function unsavedProgress(audit: OfflineAudit, writes: AuditWriteJob[]) {
  const last = writes.at(-1)?.operation.responses;
  if (!last) return true;
  const keys = Object.keys(audit.responses);
  return (
    keys.length !== Object.keys(last).length ||
    keys.some((key) => audit.responses[key] !== last[key])
  );
}

/**
 * Moves a device audit, given its queued writes:
 *
 * | status     | answered   | progressSaved          | issueRaised         | completed              |
 * | ---------- | ---------- | ---------------------- | ------------------- | ---------------------- |
 * | draft      | draft      | inProgress, start      | inProgress, start   | completed, start, save |
 * | inProgress | inProgress | save, if answers moved | ignored             | completed, save        |
 * | completed  | throws     | ignored                | ignored             | ignored                |
 *
 * Completing throws while a required item is unanswered.
 */
export function offlineAuditTransition(
  audit: OfflineAudit,
  writes: AuditWriteJob[],
  event: OfflineAuditEvent,
): OfflineAuditStep {
  const unchanged = { audit, queue: [] };
  switch (event.type) {
    case "answered":
      if (audit.status === "completed")
        throw new Error("This audit has been completed.");
      return {
        audit: {
          ...audit,
          responses: { ...audit.responses, [event.itemId]: event.value },
        },
        queue: [],
      };
    case "issueRaised":
      return audit.status === "draft" ? start(audit) : unchanged;
    case "progressSaved":
      if (audit.status === "draft") return start(audit);
      return audit.status === "inProgress" && unsavedProgress(audit, writes)
        ? { audit, queue: [save(audit, writes, event.saveId)] }
        : unchanged;
    case "completed": {
      if (audit.status === "completed") return unchanged;
      if (
        progressFor(audit.template.definition, audit.responses).requiredLeft > 0
      )
        throw new Error("Complete every required item first.");
      const begun = audit.status === "draft" ? start(audit).queue : [];
      return {
        audit: { ...audit, status: "completed" },
        queue: [
          ...begun,
          save(audit, [...writes, ...begun], event.saveId, {
            startedAt: audit.startedAt,
            completedAt: event.completedAt,
          }),
        ],
      };
    }
    default:
      return unknownEvent(event);
  }
}

/** Puts a draft on the server, in progress, under its own ID. */
function start(audit: OfflineAudit): OfflineAuditStep {
  return {
    audit: { ...audit, status: "inProgress" },
    queue: [
      pendingJob(
        {
          id: audit.id,
          type: "auditStart",
          projectId: audit.projectId,
          templateId: audit.template.id,
          templateVersion: audit.template.version,
          responses: { ...audit.responses },
        },
        [],
      ),
    ],
  };
}

/** Saves the answers over the revision the audit's last write leaves. */
function save(
  audit: OfflineAudit,
  writes: AuditWriteJob[],
  id: string,
  completion?: { completedAt: string; startedAt: string },
): AuditWriteJob {
  const last = writes.at(-1);
  if (!last) throw new Error("This audit is not on the server yet.");
  return pendingJob(
    {
      id,
      type: "auditSave",
      auditId: audit.id,
      expectedRevision: writes.length,
      responses: { ...audit.responses },
      ...(completion ? { completion } : {}),
    },
    [last.id],
  );
}

function unknownEvent(event: never): never {
  throw new Error(`Unknown offline audit event: ${JSON.stringify(event)}`);
}
