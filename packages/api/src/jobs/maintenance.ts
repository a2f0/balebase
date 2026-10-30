import type { JobOutput } from "@balebase/validators/adminJobs";
import { purgePendingAuditIssueImages } from "../audits/auditIssueImageCleanup";
import { purgeDiscardedAuditForms } from "../audits/discardedTemplatePurge";
import { purgeExpiredFreeAuditRuns } from "../billing/billingRetention";
import { reconcileSubscriptionSeats } from "../billing/billingSeats";
import { purgeStripeWebhookReceipts } from "../billing/billingWebhook";
import { maintainContracts } from "../contracts/contractReminders";
import { refreshActiveCheckrScreenings } from "../employeeForms/checkrSync";
import { purgeDeletedObjects } from "../library/deletedObjectCleanup";
import { purgeDeletedOrganizations } from "../organizations/organizationPurge";
import { captureApiError } from "../shared/diagnostics";
import type { Bindings } from "../types";
import { purgeRequestedUsers } from "../users/userDeletion";
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
      "Permanently deletes accounts requested for deletion at least 30 days ago. Skips admins, active organization members, and accounts required by retained audit, financial, or contract records.",
  },
  {
    id: "purgeExpiredFreeAuditRuns",
    name: "Purge expired Free audit history",
    description:
      "Permanently deletes audit runs that meet the existing Free-plan retention policy. Organizations whose paid plan ended keep their history for a 30-day grace period first.",
  },
  {
    id: "purgeDiscardedAuditForms",
    name: "Purge discarded global forms",
    description:
      "Permanently deletes up to 100 global audit forms discarded at least 30 days ago, with their versions and history. Audits started from them keep their own copies. Restoration is no longer possible after the purge.",
  },
  {
    id: "purgeDeletedObjects",
    name: "Purge deleted files",
    description:
      "Deletes a batch of queued files from storage after their upload grace period.",
  },
  {
    id: "purgePendingAuditIssueImages",
    name: "Purge abandoned audit images",
    description: "Removes expired, unfinished audit image uploads.",
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
type MaintenanceTasks = Record<MaintenanceJobId, () => Promise<JobOutput>>;
type RunSource =
  | { trigger: "manual"; actorUserId: string }
  | { trigger: "scheduled"; cron: string; scheduledTime: number };

export function maintenanceTasks(environment: Bindings): MaintenanceTasks {
  return {
    purgeDeletedOrganizations: () => purgeDeletedOrganizations(environment),
    purgeRequestedUsers: () => purgeRequestedUsers(environment),
    purgeDeletedObjects: async () => ({
      purged: await purgeDeletedObjects(environment),
    }),
    purgeExpiredFreeAuditRuns: async () => ({
      purged: await purgeExpiredFreeAuditRuns(environment),
    }),
    purgeDiscardedAuditForms: async () => ({
      purged: await purgeDiscardedAuditForms(environment),
    }),
    purgePendingAuditIssueImages: async () => ({
      purged: await purgePendingAuditIssueImages(environment),
    }),
    purgeStripeWebhookReceipts: async () => ({
      purged: await purgeStripeWebhookReceipts(environment),
    }),
    reconcileSubscriptionSeats: () => reconcileSubscriptionSeats(environment),
    maintainContracts: async () => ({
      reminded: await maintainContracts(environment),
    }),
    refreshCheckrScreenings: async () => {
      const { refreshed, skipped, notifications } =
        await refreshActiveCheckrScreenings(environment);
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

export async function enqueueMaintenance(
  env: Bindings,
  jobId: MaintenanceJobId,
  source: RunSource,
  dependsOn: string | null = null,
) {
  if (!env.FINANCE_SYNC_QUEUE)
    throw new Error("Background job queue is not configured.");
  const scheduled = source.trigger === "scheduled" ? source : null;
  const id = scheduled
    ? `scheduled:${jobId}:${scheduled.scheduledTime}`
    : crypto.randomUUID();
  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO job_runs
      (id, job_id, source, requested_by, cron, scheduled_time, depends_on, available_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id,
      jobId,
      source.trigger,
      source.trigger === "manual" ? source.actorUserId : null,
      scheduled?.cron ?? null,
      scheduled?.scheduledTime ?? null,
      dependsOn,
      now,
      now,
    ),
    env.DB.prepare(`SELECT * FROM job_runs WHERE job_id = ?
      AND (id = ? OR status IN ('queued', 'running'))
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(jobId, id),
  ]);
  const job = results.at(-1)?.results[0] as JobRow | undefined;
  if (!job) throw new Error("Maintenance job could not be saved.");
  if (job.status === "queued") await dispatchJob(env, job.id);
  return job;
}

export async function runMaintenanceJob(
  database: D1Database,
  job: JobRow,
  task: (() => Promise<JobOutput>) | undefined,
) {
  console.log({
    event: "background_job",
    runId: job.id,
    jobId: job.job_id,
    status: "running",
  });
  let output: JobOutput | null = null;
  let errorCode: string | null = null;
  try {
    if (!task) throw new Error("Unknown job handler.");
    output = await task();
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

export async function runScheduledMaintenance(
  env: Bindings,
  source: Extract<RunSource, { trigger: "scheduled" }>,
) {
  const retention = await enqueueMaintenance(
    env,
    "purgeExpiredFreeAuditRuns",
    source,
  );
  // Newly scheduled cleanup waits for retention. An existing active manual run
  // is reused and can overlap; its per-object claims and grace periods still apply.
  for (const { id } of maintenanceJobs) {
    if (id !== "purgeExpiredFreeAuditRuns")
      await enqueueMaintenance(
        env,
        id,
        source,
        id === "purgeDeletedObjects" ? retention.id : null,
      );
  }
}
