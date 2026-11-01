import { stillManages } from "../organizations/organizationMembers";
import { activityBatch } from "../shared/activity";
import type { Bindings } from "../types";
import { getCheckrReport } from "./checkr";
import { isClosedReportStatus } from "./checkrScreening";
import {
  jsonBoolean,
  type ScreeningActor,
  screeningActivityStatement,
} from "./requirementActivity";
import { sendPendingScreeningNotifications } from "./screeningNotifications";

export interface CheckrScreeningRow {
  id: string;
  organization_id: string;
  status: string;
  checkr_report_id: string;
  checkr_report_status: string | null;
  checkr_refresh_revision: number;
}

/** What brought a refresh: a manager, Checkr's webhook, or the hourly job. */
type ScreeningRefreshVia = "manual" | "scheduled" | "webhook";

// Records the current Checkr report state on an ordered screening, and clears
// any refresh requested before this one began. Returns null when another
// refresh or edit changed it first, or when a manager's refresh finds them no
// longer an owner or admin. Every attempt records checkr_checked_at, so a
// screening Checkr keeps failing on cannot hold its place at the front of the
// scheduled refresh. A refresh that changes the screening's status, report
// status, or result records `employee_requirement.screening_updated` in the
// same transaction, by the manager who asked or by Checkr; a provider event
// its cause already recorded holds the change back for a later refresh, so
// the change never lands without its history.
export async function refreshCheckrScreening(
  env: Bindings,
  row: CheckrScreeningRow,
  actor: ScreeningActor,
  via: ScreeningRefreshVia,
) {
  const checkedAt = new Date().toISOString();
  const report = await getCheckrReport(env, row.checkr_report_id).catch(
    async (cause: unknown) => {
      await env.DB.prepare(
        `UPDATE employee_requirements SET checkr_checked_at = ?
         WHERE id = ? AND organization_id = ?`,
      )
        .bind(checkedAt, row.id, row.organization_id)
        .run();
      throw cause;
    },
  );
  const reportStatus =
    report.status === "complete" && report.includes_canceled
      ? report.result
        ? "partially_canceled"
        : "canceled"
      : report.status;
  // A manager may complete a canceled screening by hand; keep that.
  const complete =
    (report.status === "complete" && !report.includes_canceled) ||
    (row.status === "complete" &&
      isClosedReportStatus(row.checkr_report_status));
  const nextStatus = complete
    ? "complete"
    : isClosedReportStatus(reportStatus)
      ? "pending"
      : "in_progress";
  const now = new Date().toISOString();
  const result = report.result ?? null;
  const { changed, guard } = refreshGuard(row, actor, {
    reportStatus,
    result,
    status: nextStatus,
  });
  const [, refreshed] = await activityBatch(
    env.DB,
    "type" in actor ? undefined : actor.apiKey,
    [
      screeningActivityStatement(
        env.DB,
        actor,
        {
          action: "employee_requirement.screening_updated",
          details: {
            bindings: [via, nextStatus, reportStatus, result, result],
            sql: `'via', ?, 'previousStatus', status, 'status', ?,
              'previousReportStatus', checkr_report_status,
              'reportStatus', ?,
              'resultChanged', ${jsonBoolean("checkr_result IS NOT ?")},
              'hasResult', ${jsonBoolean("? IS NOT NULL")}`,
          },
          organizationId: row.organization_id,
          requirementId: row.id,
        },
        {
          bindings: [...guard.bindings, ...changed.bindings],
          sql: `${guard.sql} AND ${changed.sql}`,
        },
      ),
      // changes() is the event's insert: a change without its event waits.
      env.DB.prepare(
        `UPDATE employee_requirements
         SET checkr_report_status = ?, checkr_result = ?, status = ?,
             completed_at = CASE WHEN ? = 'complete'
               THEN COALESCE(completed_at, ?) ELSE NULL END,
             updated_at = ?, checkr_checked_at = ?,
             checkr_refresh_requested_at = CASE
               WHEN checkr_refresh_requested_at <= ? THEN NULL
               ELSE checkr_refresh_requested_at
             END,
             checkr_refresh_revision = checkr_refresh_revision + 1
         WHERE ${guard.sql} AND (NOT ${changed.sql} OR changes() > 0)`,
      ).bind(
        reportStatus,
        result,
        nextStatus,
        nextStatus,
        now,
        now,
        checkedAt,
        checkedAt,
        ...guard.bindings,
        ...changed.bindings,
      ),
    ],
  );
  if (!refreshed?.meta.changes) return null;
  const notifications = await sendPendingScreeningNotifications(env, row.id);
  return { reportStatus, result: report.result ?? null, notifications };
}

/**
 * The refresh's guard (the revision it read, and for a manager that they
 * still manage) and whether it changes what the screening shows.
 */
function refreshGuard(
  row: CheckrScreeningRow,
  actor: ScreeningActor,
  next: { reportStatus: string; result: string | null; status: string },
) {
  const manages =
    "type" in actor
      ? { bindings: [], sql: "1 = 1" }
      : stillManages(row.organization_id, actor.userId);
  return {
    changed: {
      bindings: [next.status, next.reportStatus, next.result],
      sql: `(status IS NOT ? OR checkr_report_status IS NOT ?
        OR checkr_result IS NOT ?)`,
    },
    guard: {
      bindings: [
        row.id,
        row.organization_id,
        row.checkr_report_id,
        row.checkr_refresh_revision,
        ...manages.bindings,
      ],
      sql: `id = ? AND organization_id = ? AND checkr_report_id = ?
        AND checkr_refresh_revision = ? AND ${manages.sql}`,
    },
  };
}
