import type { JobOutput } from "@balebase/validators/adminJobs";
import {
  previewExpiredFreeFormRunPurge,
  purgeExpiredFreeFormRuns,
} from "../billing/billingRetention";
import {
  previewSubscriptionSeatReconciliation,
  reconcileSubscriptionSeats,
} from "../billing/billingSeats";
import {
  previewStripeWebhookReceiptPurge,
  purgeStripeWebhookReceipts,
} from "../billing/billingWebhook";
import {
  maintainContracts,
  previewContractMaintenance,
} from "../contracts/contractReminders";
import {
  previewCheckrScreeningRefresh,
  refreshActiveCheckrScreenings,
} from "../employeeForms/checkrSync";
import {
  previewDiscardedFormTemplatePurge,
  purgeDiscardedFormTemplates,
} from "../forms/discardedTemplatePurge";
import {
  previewPendingFormIssueImagePurge,
  purgePendingFormIssueImages,
} from "../forms/formIssueImageCleanup";
import {
  previewTrashedEmailPurge,
  purgeTrashedEmails,
} from "../inbox/trashedEmailPurge";
import {
  previewDeletedObjectPurge,
  purgeDeletedObjects,
} from "../library/deletedObjectCleanup";
import {
  previewDeletedOrganizationPurge,
  purgeDeletedOrganizations,
} from "../organizations/organizationPurge";
import { captureApiError } from "../shared/diagnostics";
import type { Bindings } from "../types";
import {
  previewRequestedUserPurge,
  purgeRequestedUsers,
} from "../users/userDeletion";
import { dispatchJob, type JobRow } from "./jobRuns";
import { MaintenanceFailure } from "./maintenanceFailure";

export const maintenanceJobs = [
  {
    id: "purgeDeletedOrganizations",
    name: "Purge deleted organizations",
    description:
      "Permanently deletes up to 25 organizations deleted at least 30 days ago and their workspace records. Files are queued for the Purge deleted files job after its upload grace period. Restoration is no longer possible after the purge.",
  },
  {
    id: "purgeRequestedUsers",
    name: "Purge requested user accounts",
    description:
      "Permanently deletes accounts requested for deletion at least 30 days ago. Skips admins, active organization members, and accounts required by retained form, financial, or contract records.",
  },
  {
    id: "purgeExpiredFreeFormRuns",
    name: "Purge expired Free form history",
    description:
      "Permanently deletes forms that meet the existing Free-plan retention policy. Organizations whose paid plan ended keep their history for a 30-day grace period first.",
  },
  {
    id: "purgeDiscardedFormTemplates",
    name: "Purge discarded global templates",
    description:
      "Permanently deletes up to 100 global form templates discarded at least 30 days ago, with their versions and history. Forms started from them keep their own copies. Restoration is no longer possible after the purge.",
  },
  {
    id: "purgeTrashedEmails",
    name: "Purge trashed email",
    description:
      "Permanently deletes up to 100 inbox emails that have been in Trash for at least 30 days, with their attachments and links, and queues their files for the Purge deleted files job. Each email's history records the purge. Restoration is no longer possible after the purge.",
  },
  {
    id: "purgeDeletedObjects",
    name: "Purge deleted files",
    description:
      "Deletes a batch of queued files from storage after their upload grace period.",
  },
  {
    id: "purgePendingFormIssueImages",
    name: "Purge abandoned form images",
    description: "Removes expired, unfinished form image uploads.",
  },
  {
    id: "purgeStripeWebhookReceipts",
    name: "Purge old billing receipts",
    description: "Deletes Stripe webhook receipts past their retention period.",
  },
  {
    id: "reconcileSubscriptionSeats",
    name: "Reconcile subscription seats",
    description:
      "Synchronizes seat quantities with Stripe. May change billing quantities.",
  },
  {
    id: "maintainContracts",
    name: "Maintain contracts",
    description:
      "Sends due reminder emails and resumes stalled signing workflows.",
  },
  {
    id: "refreshCheckrScreenings",
    name: "Refresh Checkr screenings",
    description:
      "Re-reads unfinished Checkr screenings and retries pending completion emails.",
  },
] as const;

export type MaintenanceJobId = (typeof maintenanceJobs)[number]["id"];

export function isMaintenanceJobId(id: string): id is MaintenanceJobId {
  return maintenanceJobs.some((job) => job.id === id);
}

/** Each task receives its run's ID, the cause its system events record. */
type MaintenanceTasks = Record<
  MaintenanceJobId,
  (runId: string) => Promise<JobOutput>
>;
type RunSource =
  | { trigger: "manual"; actorUserId: string; dryRun?: boolean }
  | { trigger: "scheduled"; cron: string; scheduledTime: number };

function maintenanceTasks(environment: Bindings): MaintenanceTasks {
  return {
    purgeDeletedOrganizations: (runId) =>
      purgeDeletedOrganizations(environment, runId),
    purgeRequestedUsers: (runId) => purgeRequestedUsers(environment, runId),
    purgeDeletedObjects: async () => ({
      purged: await purgeDeletedObjects(environment),
    }),
    purgeExpiredFreeFormRuns: async (runId) => ({
      purged: await purgeExpiredFreeFormRuns(environment, runId),
    }),
    purgeDiscardedFormTemplates: async (runId) => ({
      purged: await purgeDiscardedFormTemplates(environment, runId),
    }),
    purgeTrashedEmails: async (runId) => ({
      purged: await purgeTrashedEmails(environment, runId),
    }),
    purgePendingFormIssueImages: async () => ({
      purged: await purgePendingFormIssueImages(environment),
    }),
    purgeStripeWebhookReceipts: async () => ({
      purged: await purgeStripeWebhookReceipts(environment),
    }),
    reconcileSubscriptionSeats: (runId) =>
      reconcileSubscriptionSeats(environment, runId),
    maintainContracts: async () => ({
      reminded: await maintainContracts(environment),
    }),
    refreshCheckrScreenings: async (runId) => {
      const { refreshed, skipped, notifications } =
        await refreshActiveCheckrScreenings(environment, runId);
      return {
        refreshed,
        skipped,
        notificationsSent: notifications.sent,
        notificationsFailed: notifications.failed,
        notificationsAbandoned: notifications.abandoned,
        notificationQueueUnavailable: notifications.queueUnavailable,
      };
    },
  };
}

/**
 * Each job's dry run: read-only queries that count what the job would change
 * now, within its batch limits. They write nothing, call no provider, and
 * send no email.
 */
export function maintenanceDryRuns(environment: Bindings): MaintenanceTasks {
  return {
    purgeDeletedOrganizations: () =>
      previewDeletedOrganizationPurge(environment),
    purgeRequestedUsers: () => previewRequestedUserPurge(environment),
    purgeDeletedObjects: () => previewDeletedObjectPurge(environment),
    purgeExpiredFreeFormRuns: () => previewExpiredFreeFormRunPurge(environment),
    purgeDiscardedFormTemplates: () =>
      previewDiscardedFormTemplatePurge(environment),
    purgeTrashedEmails: () => previewTrashedEmailPurge(environment),
    purgePendingFormIssueImages: () =>
      previewPendingFormIssueImagePurge(environment),
    purgeStripeWebhookReceipts: () =>
      previewStripeWebhookReceiptPurge(environment),
    reconcileSubscriptionSeats: () =>
      previewSubscriptionSeatReconciliation(environment),
    maintainContracts: () => previewContractMaintenance(environment),
    refreshCheckrScreenings: () => previewCheckrScreeningRefresh(environment),
  };
}

/** The task a claimed maintenance run performs: the job, or its dry run. */
export function maintenanceTask(environment: Bindings, job: JobRow) {
  if (!isMaintenanceJobId(job.job_id)) return undefined;
  return (job.dry_run ? maintenanceDryRuns : maintenanceTasks)(environment)[
    job.job_id
  ];
}

/**
 * Saves a run, or reuses the job's active run, and dispatches it. A manual
 * request is recorded with the requester's snapshot in the same transaction,
 * including when it joins an active run. It returns null, writing nothing,
 * when the requester is no longer a root admin. A dry run only joins an
 * active dry run, and a real run only a real one.
 */
export async function enqueueMaintenance(
  env: Bindings,
  jobId: MaintenanceJobId,
  source: Extract<RunSource, { trigger: "scheduled" }>,
  dependsOn?: string | null,
): Promise<JobRow>;
export async function enqueueMaintenance(
  env: Bindings,
  jobId: MaintenanceJobId,
  source: Extract<RunSource, { trigger: "manual" }>,
): Promise<JobRow | null>;
export async function enqueueMaintenance(
  env: Bindings,
  jobId: MaintenanceJobId,
  source: RunSource,
  dependsOn: string | null = null,
): Promise<JobRow | null> {
  if (!env.FINANCE_SYNC_QUEUE)
    throw new Error("Background job queue is not configured.");
  const scheduled = source.trigger === "scheduled" ? source : null;
  const dryRun = source.trigger === "manual" && source.dryRun === true;
  const id = scheduled
    ? `scheduled:${jobId}:${scheduled.scheduledTime}`
    : crypto.randomUUID();
  const now = new Date().toISOString();
  const selectRun = env.DB.prepare(`SELECT * FROM job_runs WHERE job_id = ?
      AND (id = ? OR (status IN ('queued', 'running') AND dry_run = ?))
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(
    jobId,
    id,
    Number(dryRun),
  );
  const results = await env.DB.batch(
    source.trigger === "manual"
      ? [
          ...manualRequestStatements(env.DB, {
            actorUserId: source.actorUserId,
            dependsOn,
            dryRun,
            id,
            jobId,
            now,
          }),
          selectRun,
        ]
      : [
          env.DB.prepare(`INSERT OR IGNORE INTO job_runs
      (id, job_id, source, cron, scheduled_time, depends_on, available_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
            id,
            jobId,
            source.trigger,
            scheduled?.cron ?? null,
            scheduled?.scheduledTime ?? null,
            dependsOn,
            now,
            now,
          ),
          selectRun,
        ],
  );
  if (source.trigger === "manual" && !results[0]?.results.length) return null;
  const job = results.at(-1)?.results[0] as JobRow | undefined;
  if (!job) throw new Error("Maintenance job could not be saved.");
  if (job.status === "queued") await dispatchJob(env, job.id);
  return job;
}

// The requester's stored role, not the session's, so a demoted admin's request
// records and starts nothing. Binds the requester's ID; the user is `actor`.
export const requesterGuard = `actor.id = ?
  AND instr(',' || replace(COALESCE(actor.role, ''), ' ', '') || ',', ',admin,') > 0`;

function manualRequestStatements(
  database: D1Database,
  input: {
    actorUserId: string;
    dependsOn: string | null;
    dryRun: boolean;
    id: string;
    jobId: MaintenanceJobId;
    now: string;
  },
) {
  const { actorUserId, dependsOn, id, jobId, now } = input;
  const dryRun = Number(input.dryRun);
  // The new run, or the active run that the unique index kept it from adding.
  const requestedRun = `FROM job_runs AS run JOIN user AS actor ON ${requesterGuard}
    WHERE run.job_id = ? AND (run.id = ?
      OR (run.status IN ('queued', 'running') AND run.dry_run = ?))
    ORDER BY run.created_at DESC, run.rowid DESC LIMIT 1`;
  const [requested, joined] = input.dryRun
    ? [
        "Manual dry run requested.",
        "Manual request joined this active dry run.",
      ]
    : ["Manual run requested.", "Manual request joined this active run."];
  return [
    database
      .prepare(`SELECT actor.id FROM user AS actor WHERE ${requesterGuard}`)
      .bind(actorUserId),
    database
      .prepare(`INSERT OR IGNORE INTO job_runs
      (id, job_id, source, dry_run, requested_by, requested_by_name,
       requested_by_email, depends_on, available_at, created_at)
      SELECT ?, ?, 'manual', ?, actor.id, actor.name, actor.email, ?, ?, ?
      FROM user AS actor WHERE ${requesterGuard}`)
      .bind(id, jobId, dryRun, dependsOn, now, now, actorUserId),
    database
      .prepare(`INSERT INTO job_logs (run_id, occurred_at, level, message, details_json)
      SELECT run.id, ?, 'info',
        CASE WHEN run.id = ? THEN ? ELSE ? END,
        json_object('requestedBy',
          json_object('id', actor.id, 'name', actor.name, 'email', actor.email))
      ${requestedRun}`)
      .bind(now, id, requested, joined, actorUserId, jobId, id, dryRun),
    database
      .prepare(`INSERT INTO maintenance_requests
      (id, job_id, run_id, joined_active_run, dry_run, requested_at,
       actor_user_id, actor_name, actor_email)
      SELECT ?, run.job_id, run.id, run.id <> ?, run.dry_run, ?, actor.id,
        actor.name, actor.email
      ${requestedRun}`)
      .bind(crypto.randomUUID(), id, now, actorUserId, jobId, id, dryRun),
  ];
}

export async function runMaintenanceJob(
  database: D1Database,
  job: JobRow,
  task: ((runId: string) => Promise<JobOutput>) | undefined,
) {
  console.log({
    event: "background_job",
    runId: job.id,
    jobId: job.job_id,
    dryRun: Boolean(job.dry_run),
    status: "running",
  });
  let output: JobOutput | null = null;
  let errorCode: string | null = null;
  try {
    if (!task) throw new Error("Unknown job handler.");
    output = await task(job.id);
  } catch (cause) {
    if (cause instanceof MaintenanceFailure) output = cause.output;
    console.error(
      { event: "background_job_error", runId: job.id, jobId: job.job_id },
      cause,
    );
    await captureApiError(cause, "job-error");
    errorCode = "MAINTENANCE_FAILED";
  }
  // A failed completion write leaves the lease in place: recovery marks it
  // interrupted instead of repeating possibly completed external side effects.
  await database
    .prepare(`UPDATE job_runs SET status = ?, output_json = ?, error_code = ?,
    finished_at = ?, lease_until = NULL WHERE id = ? AND status = 'running' AND lease_until = ?`)
    .bind(
      errorCode ? "failed" : "succeeded",
      output ? JSON.stringify(output) : null,
      errorCode,
      new Date().toISOString(),
      job.id,
      job.lease_until,
    )
    .run();
  console.log({
    event: "background_job",
    runId: job.id,
    jobId: job.job_id,
    status: errorCode ? "failed" : "succeeded",
    output,
    errorCode,
  });
}
