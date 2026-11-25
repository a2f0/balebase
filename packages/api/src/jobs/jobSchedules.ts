import type {
  JobSchedule,
  JobScheduleChange,
} from "@balebase/validators/adminJobs";
import {
  cronMatches,
  describeCron,
  nextCronRun,
  parseCron,
} from "@balebase/validators/cron";
import {
  cursorPage,
  decodeCursor,
  encodeCursor,
} from "../shared/cursorPagination";
import type { Bindings } from "../types";
import type { JobRow } from "./jobRuns";
import {
  enqueueMaintenance,
  type MaintenanceJobId,
  maintenanceJobs,
  requesterGuard,
} from "./maintenance";

interface JobScheduleRow {
  job_id: string;
  cron: string;
  enabled: number;
  updated_at: string;
  updated_by: string | null;
  updated_by_name: string | null;
  updated_by_email: string | null;
}

interface JobScheduleChangeRow {
  id: string;
  job_id: string;
  changed_at: string;
  previous_cron: string | null;
  previous_enabled: number | null;
  cron: string;
  enabled: number;
  actor_user_id: string;
  actor_name: string;
  actor_email: string;
}

const changePageSize = 50;
const minuteMs = 60_000;

/** Every saved schedule by job ID. A job without one runs only on request. */
export async function readJobSchedules(database: D1Database) {
  const { results } = await database
    .prepare("SELECT * FROM job_schedules")
    .all<JobScheduleRow>();
  return new Map(results.map((row) => [row.job_id, row]));
}

/** The schedule as root admins read it, with its next run after `now`. */
export function toJobSchedule(
  row: JobScheduleRow | undefined,
  now = new Date(),
): JobSchedule | null {
  if (!row) return null;
  const parsed = parseCron(row.cron);
  return {
    cron: row.cron,
    enabled: Boolean(row.enabled),
    nextRunAt:
      row.enabled && parsed
        ? (nextCronRun(parsed, now)?.toISOString() ?? null)
        : null,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
      ? {
          id: row.updated_by,
          name: row.updated_by_name ?? "",
          email: row.updated_by_email ?? "",
        }
      : null,
  };
}

/** The schedule in a sentence for the jobs list. */
export function describeJobSchedule(schedule: JobSchedule | null) {
  if (!schedule?.enabled) return "Not scheduled; runs only on request.";
  return `${describeCron(schedule.cron)}.`;
}

/**
 * Queues each maintenance job whose enabled schedule matches the minute of
 * `scheduledTime`, the Cron Trigger's own time. Run IDs name the job and the
 * minute, so a repeated or overlapping trigger queues nothing twice. Form
 * retention goes first, and file cleanup due in the same minute waits for
 * it, so files the retention purge queues are removed in the same pass. One
 * job's failure does not keep the others from being queued.
 */
export async function runDueMaintenance(env: Bindings, scheduledTime: number) {
  const minute = Math.floor(scheduledTime / minuteMs) * minuteMs;
  const schedules = await readJobSchedules(env.DB);
  const due = new Map<MaintenanceJobId, string>();
  for (const { id } of maintenanceJobs) {
    const row = schedules.get(id);
    const parsed = row?.enabled ? parseCron(row.cron) : null;
    if (row && parsed && cronMatches(parsed, new Date(minute)))
      due.set(id, row.cron);
  }
  const queue = (
    jobId: MaintenanceJobId,
    cron: string,
    dependsOn: string | null = null,
  ) =>
    enqueueMaintenance(
      env,
      jobId,
      { trigger: "scheduled", cron, scheduledTime: minute },
      dependsOn,
    );
  const failures: unknown[] = [];
  let retention: JobRow | null = null;
  const retentionCron = due.get("purgeExpiredFreeFormRuns");
  if (retentionCron) {
    try {
      retention = await queue("purgeExpiredFreeFormRuns", retentionCron);
    } catch (cause) {
      failures.push(cause);
    }
  }
  const queued = retention ? [retention] : [];
  for (const [jobId, cron] of due) {
    if (jobId === "purgeExpiredFreeFormRuns") continue;
    try {
      queued.push(
        await queue(
          jobId,
          cron,
          jobId === "purgeDeletedObjects" ? (retention?.id ?? null) : null,
        ),
      );
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Scheduled maintenance failed.");
  return queued;
}

/**
 * Saves a job's schedule and records the change with the admin's snapshot
 * in one transaction. Returns false, writing nothing, when the admin's
 * stored role is no longer `admin`. Saving the schedule it already has
 * records nothing.
 */
export async function saveJobSchedule(
  database: D1Database,
  input: {
    actorUserId: string;
    cron: string;
    enabled: boolean;
    jobId: MaintenanceJobId;
  },
) {
  const now = new Date().toISOString();
  const enabled = Number(input.enabled);
  const [actor] = await database.batch([
    database
      .prepare(`SELECT actor.id FROM user AS actor WHERE ${requesterGuard}`)
      .bind(input.actorUserId),
    database
      .prepare(`INSERT INTO job_schedule_changes
        (id, job_id, changed_at, previous_cron, previous_enabled, cron, enabled,
         actor_user_id, actor_name, actor_email)
        SELECT ?, ?, ?, current.cron, current.enabled, ?, ?,
          actor.id, actor.name, actor.email
        FROM user AS actor
        LEFT JOIN job_schedules AS current ON current.job_id = ?
        WHERE ${requesterGuard}
          AND (current.job_id IS NULL OR current.cron <> ? OR current.enabled <> ?)`)
      .bind(
        crypto.randomUUID(),
        input.jobId,
        now,
        input.cron,
        enabled,
        input.jobId,
        input.actorUserId,
        input.cron,
        enabled,
      ),
    database
      .prepare(`INSERT INTO job_schedules
        (job_id, cron, enabled, updated_at, updated_by, updated_by_name, updated_by_email)
        SELECT ?, ?, ?, ?, actor.id, actor.name, actor.email
        FROM user AS actor WHERE ${requesterGuard}
        ON CONFLICT(job_id) DO UPDATE SET cron = excluded.cron,
          enabled = excluded.enabled, updated_at = excluded.updated_at,
          updated_by = excluded.updated_by,
          updated_by_name = excluded.updated_by_name,
          updated_by_email = excluded.updated_by_email
        WHERE job_schedules.cron <> excluded.cron
          OR job_schedules.enabled <> excluded.enabled`)
      .bind(input.jobId, input.cron, enabled, now, input.actorUserId),
  ]);
  return Boolean(actor?.results.length);
}

/** A job's schedule changes, newest first. Null for a bad cursor. */
export async function listJobScheduleChanges(
  database: D1Database,
  jobId: string,
  cursor: string | undefined,
) {
  const boundary = cursor === undefined ? null : decodeCursor(cursor, 500);
  if (cursor !== undefined && !boundary) return null;
  const { results } = await database
    .prepare(
      `SELECT * FROM job_schedule_changes WHERE job_id = ?
       ${boundary ? "AND (changed_at, id) < (?, ?)" : ""}
       ORDER BY changed_at DESC, id DESC LIMIT ?`,
    )
    .bind(jobId, ...(boundary ?? []), changePageSize + 1)
    .all<JobScheduleChangeRow>();
  const page = cursorPage(results, changePageSize, (row) =>
    encodeCursor(row.changed_at, row.id),
  );
  return {
    changes: page.items.map(
      (row): JobScheduleChange => ({
        actor: {
          email: row.actor_email,
          id: row.actor_user_id,
          name: row.actor_name,
        },
        changedAt: row.changed_at,
        cron: row.cron,
        enabled: Boolean(row.enabled),
        id: row.id,
        jobId: row.job_id,
        previousCron: row.previous_cron,
        previousEnabled:
          row.previous_enabled === null ? null : Boolean(row.previous_enabled),
      }),
    ),
    nextCursor: page.nextCursor,
  };
}
