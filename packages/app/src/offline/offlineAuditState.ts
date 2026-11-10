import type {
  OfflineAuditState,
  OfflineOperation,
} from "@balebase/validators/offline";
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
  /**
   * An answer given at `at` over the server answer of time `base`: the one
   * shown when it was given (`answerBase`).
   */
  | {
      at: string;
      base: string | null;
      itemId: string;
      type: "answered";
      value: string;
    }
  /** Share a draft with the server, as an in-progress audit. */
  | { type: "shared" }
  /** An issue was raised on one of its items; the issue needs it on the server. */
  | { type: "issueRaised" }
  /** Send the answers given here since the last write. */
  | { saveId: string; type: "pushed" }
  | { completedAt: string; saveId: string; type: "completed" }
  /** The server applied write `job`, answering with its copy of the audit. */
  | { job: string; state: OfflineAuditState; type: "confirmed" }
  /** The server's copy, read for what others changed. */
  | { state: OfflineAuditState; type: "pulled" };

/** The audit after an event, and the server writes the event queues. */
export interface OfflineAuditStep {
  audit: OfflineAudit;
  queue: AuditWriteJob[];
}

/** The audit's queued server writes, oldest first: its start, then each save. */
export function auditWrites(jobs: OfflineJob[], auditId: string) {
  return jobs.filter(
    (job): job is AuditWriteJob =>
      (job.operation.type === "auditStart" && job.operation.id === auditId) ||
      (job.operation.type === "auditSave" && job.operation.auditId === auditId),
  );
}

/**
 * The answers shown: the server's, under those being sent, under newer ones.
 * An answer cleared on the server shows as unanswered.
 */
export function offlineAnswers(audit: OfflineAudit) {
  const answers: Record<string, string> = {};
  for (const layer of [
    audit.server.answers,
    ...audit.sending.map((entry) => entry.answers),
    audit.local,
  ])
    for (const [itemId, { value }] of Object.entries(layer))
      if (value === null) delete answers[itemId];
      else answers[itemId] = value;
  return answers;
}

/** Whether answers given here have yet to reach the server. */
export function unsyncedAnswers(audit: OfflineAudit) {
  return Object.keys(audit.local).length > 0 || audit.sending.length > 0;
}

/**
 * Whether answers given here are due to be sent: the audit is shared, every
 * write before has synced (one save at a time keeps answers coalesced), and
 * there is something to send. A completed audit still sends answers written
 * after it was sealed, which the server records as discarded.
 */
export function pushDue(audit: OfflineAudit, writes: AuditWriteJob[]) {
  return (
    audit.status !== "draft" &&
    Object.keys(audit.local).length > 0 &&
    writes.length > 0 &&
    writes.every((job) => job.status === "synced")
  );
}

/**
 * Moves a device audit, given its queued writes:
 *
 * | status     | answered   | shared, issueRaised | pushed         | completed              | confirmed, pulled         |
 * | ---------- | ---------- | ------------------- | -------------- | ---------------------- | ------------------------- |
 * | draft      | draft      | inProgress, start   | ignored        | completed, start, save | ignored                   |
 * | inProgress | inProgress | ignored             | save, when due | completed, save        | completed if done there   |
 * | completed  | completed  | ignored             | save, when due | ignored                | inProgress if not applied |
 *
 * Answers given here wait in `local` until a write carries them, then in
 * `sending` until the server confirms it. The server's copy replaces
 * `server` unless it is older than the one held. An answer the editor was
 * still writing when a completion made elsewhere sealed the audit is kept
 * and sent, so the server records it rather than the device losing it.
 * Completing throws while a required item is unanswered.
 */
export function offlineAuditTransition(
  audit: OfflineAudit,
  writes: AuditWriteJob[],
  event: OfflineAuditEvent,
): OfflineAuditStep {
  const unchanged = { audit, queue: [] };
  switch (event.type) {
    case "answered": {
      const replaced = { ...audit.replaced };
      delete replaced[event.itemId];
      const answer = { at: event.at, base: event.base, value: event.value };
      return {
        audit: {
          ...audit,
          local: { ...audit.local, [event.itemId]: answer },
          replaced,
        },
        queue: [],
      };
    }
    case "shared":
    case "issueRaised":
      return audit.status === "draft" ? start(audit) : unchanged;
    case "pushed":
      return pushDue(audit, writes)
        ? send(audit, writes, event.saveId)
        : unchanged;
    case "completed": {
      if (audit.status === "completed") return unchanged;
      if (
        progressFor(audit.template.definition, offlineAnswers(audit))
          .requiredLeft > 0
      )
        throw new Error("Complete every required item first.");
      const begun = audit.status === "draft" ? start(audit) : unchanged;
      const sent = send(
        begun.audit,
        [...writes, ...begun.queue],
        event.saveId,
        {
          startedAt: audit.startedAt,
          completedAt: event.completedAt,
        },
      );
      return {
        audit: { ...sent.audit, status: "completed" },
        queue: [...begun.queue, ...sent.queue],
      };
    }
    case "confirmed":
      return {
        audit: pull(
          confirm(audit, event.job, event.state),
          writes,
          event.state,
        ),
        queue: [],
      };
    case "pulled":
      return { audit: pull(audit, writes, event.state), queue: [] };
    default:
      return unknownEvent(event);
  }
}

/**
 * The time of the server answer an answer to `itemId` is given over: the one
 * shown, unless that is itself an unsent answer from here, which keeps the
 * base it was given over. Taken when the answer is given, so a server copy
 * read meanwhile cannot claim it was seen.
 */
export function answerBase(audit: OfflineAudit, itemId: string) {
  const local = audit.local[itemId];
  if (local) return local.base;
  for (const entry of [...audit.sending].reverse()) {
    const sent = entry.answers[itemId];
    if (sent) return sent.at;
  }
  return audit.server.answers[itemId]?.at ?? null;
}

/** Puts a draft on the server, in progress, under its own ID. */
function start(audit: OfflineAudit): OfflineAuditStep {
  return {
    audit: {
      ...audit,
      local: {},
      sending: [
        ...audit.sending,
        { answers: audit.local, completes: false, job: audit.id },
      ],
      status: "inProgress",
    },
    queue: [
      pendingJob(
        {
          id: audit.id,
          type: "auditStart",
          projectId: audit.projectId,
          templateId: audit.template.id,
          templateVersion: audit.template.version,
          answers: Object.fromEntries(
            Object.entries(audit.local).map(([itemId, { at, value }]) => [
              itemId,
              { at, value },
            ]),
          ),
        },
        [],
      ),
    ],
  };
}

/** Sends the answers given here since the last write, after that write. */
function send(
  audit: OfflineAudit,
  writes: AuditWriteJob[],
  id: string,
  completion?: { completedAt: string; startedAt: string },
): OfflineAuditStep {
  const last = writes.at(-1);
  if (!last) throw new Error("This audit is not on the server yet.");
  return {
    audit: {
      ...audit,
      local: {},
      sending: [
        ...audit.sending,
        { answers: audit.local, completes: completion !== undefined, job: id },
      ],
    },
    queue: [
      pendingJob(
        {
          id,
          type: "auditSave",
          auditId: audit.id,
          answers: audit.local,
          ...(completion ? { completion } : {}),
        },
        [last.id],
      ),
    ],
  };
}

/**
 * Drops a confirmed write, noting each of its answers the server did not
 * keep, unless a newer answer from here replaces it anyway. A completion the
 * server did not apply, because a required answer was cleared elsewhere,
 * opens the audit here again.
 */
function confirm(
  audit: OfflineAudit,
  job: string,
  state: OfflineAuditState,
): OfflineAudit {
  const index = audit.sending.findIndex((entry) => entry.job === job);
  const entry = audit.sending[index];
  if (!entry) return audit;
  const later = [
    ...audit.sending.slice(index + 1).map((other) => other.answers),
    audit.local,
  ];
  const replaced = { ...audit.replaced };
  for (const [itemId, sent] of Object.entries(entry.answers))
    if (
      state.answers[itemId]?.value !== sent.value &&
      !later.some((answers) => itemId in answers)
    )
      replaced[itemId] = { at: sent.at, value: sent.value };
  return {
    ...audit,
    replaced,
    sending: audit.sending.filter((other) => other.job !== job),
    status:
      entry.completes && state.status !== "completed"
        ? "inProgress"
        : audit.status,
  };
}

/**
 * Takes the server's copy unless it is older than the one held, then
 * follows the newest copy held: a completion made elsewhere seals the audit
 * here once nothing from here is still on its way (the server records any
 * answer from here it then discards). Reconciling against the copy held,
 * not the one arriving, lets a late confirmation seal an audit a newer copy
 * already showed completed.
 */
function pull(
  audit: OfflineAudit,
  writes: AuditWriteJob[],
  state: OfflineAuditState,
): OfflineAudit {
  const server =
    state.revision < audit.server.revision
      ? audit.server
      : {
          answers: state.answers,
          revision: state.revision,
          status: state.status,
        };
  const sealed =
    server.status === "completed" &&
    audit.status === "inProgress" &&
    !unsyncedAnswers(audit) &&
    writes.every((job) => job.status === "synced");
  return { ...audit, server, status: sealed ? "completed" : audit.status };
}

function unknownEvent(event: never): never {
  throw new Error(`Unknown offline audit event: ${JSON.stringify(event)}`);
}
