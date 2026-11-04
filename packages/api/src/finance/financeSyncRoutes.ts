import { financeRoutes } from "@balebase/validators/finance";
import {
  activityBatch,
  activityStatement,
  requestActor,
} from "../shared/activity";
import { readBody, respond } from "../shared/respond";
import type { FinanceContext } from "./financeContext";
import { enqueueSync, latestSyncJob, toSyncJob } from "./financeSyncJobs";

async function requestSync(context: FinanceContext) {
  return enqueueSync(
    context.env,
    context.get("organizationId"),
    context.req.param("id") ?? "",
    "manual",
    requestActor(context),
  );
}

/** Poll metadata without loading accounts or scanning transaction history. */
export async function connectionSyncStatus(context: FinanceContext) {
  const id = context.req.param("id") ?? "";
  const row = await context.env.DB.prepare(`SELECT status, error_code,
    error_message, last_synced_at, last_failed_sync_at FROM plaid_items
    WHERE id = ? AND organization_id = ?`)
    .bind(id, context.get("organizationId"))
    .first<{
      status: string;
      error_code: string | null;
      error_message: string | null;
      last_synced_at: string | null;
      last_failed_sync_at: string | null;
    }>();
  if (!row) return context.json({ error: "Connection not found." }, 404);
  return respond(context, financeRoutes.syncStatus, {
    connection: {
      status: row.status,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      lastSyncedAt: row.last_synced_at,
      lastFailedSyncAt: row.last_failed_sync_at,
      syncJob: await latestSyncJob(context.env.DB, id),
    },
  });
}

export async function startConnectionSync(context: FinanceContext) {
  const job = await requestSync(context);
  if (!job)
    return context.json(
      { error: "Connection not found or unavailable for sync." },
      404,
    );
  return respond(context, financeRoutes.startSync, toSyncJob(job), 202);
}

export async function updateSyncSettings(context: FinanceContext) {
  const input = await readBody(
    context,
    financeRoutes.updateSyncSettings,
    "dailySync must be a boolean.",
  );
  if (input instanceof Response) return input;
  const id = context.req.param("id") ?? "";
  const organizationId = context.get("organizationId");
  const row =
    await context.env.DB.prepare(`SELECT daily_sync, institution_name FROM plaid_items
    WHERE id = ? AND organization_id = ? AND status IN ('active', 'error')`)
      .bind(id, organizationId)
      .first<{ daily_sync: number; institution_name: string | null }>();
  if (!row)
    return context.json(
      { error: "Connection not found or disconnected." },
      404,
    );
  if (Boolean(row.daily_sync) === input.dailySync)
    return respond(context, financeRoutes.updateSyncSettings, input);
  const now = new Date().toISOString();
  const [result] = await activityBatch(context.env.DB, context.get("apiKey"), [
    context.env.DB.prepare(`UPDATE plaid_items SET daily_sync = ?, updated_at = ?
      WHERE id = ? AND organization_id = ? AND daily_sync = ? AND status IN ('active', 'error')`).bind(
      input.dailySync ? 1 : 0,
      now,
      id,
      organizationId,
      row.daily_sync,
    ),
    activityStatement(
      context.env.DB,
      {
        action: "finance.daily_sync_changed",
        actorId: requestActor(context).userId,
        occurredAt: now,
        organizationId,
        root: {
          id,
          label: row.institution_name ?? "Bank connection",
          type: "finance_connection",
        },
        subject: { id, type: "finance_connection" },
        details: {
          before: Boolean(row.daily_sync),
          after: input.dailySync,
        },
      },
      { sql: "changes() > 0", bindings: [] },
    ),
  ]);
  if (!result?.meta.changes)
    return context.json(
      { error: "Connection changed. Reload and try again." },
      409,
    );
  return respond(context, financeRoutes.updateSyncSettings, input);
}
