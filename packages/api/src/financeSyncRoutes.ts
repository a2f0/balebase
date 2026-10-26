import { financeRoutes } from "@balebase/validators/finance";
import type { FinanceContext } from "./financeContext";
import { enqueueSync, type SyncJobRow, toSyncJob } from "./financeSyncJobs";
import { respond } from "./respond";

export async function financeSyncActor(context: FinanceContext) {
  const user = context.get("authSession").user;
  const key = context.get("apiKey");
  const keyRow = key
    ? await context.env.DB.prepare(
        "SELECT name FROM organization_api_keys WHERE id = ?",
      )
        .bind(key.id)
        .first<{ name: string }>()
    : null;
  return JSON.stringify({
    userId: user.id,
    name: user.name,
    email: user.email,
    apiKeyId: key?.id ?? null,
    apiKeyName: keyRow?.name ?? null,
    channel: key?.channel ?? "web",
  });
}

async function requestSync(context: FinanceContext) {
  return enqueueSync(
    context.env,
    context.get("organizationId"),
    context.req.param("id") ?? "",
    "manual",
    await financeSyncActor(context),
  );
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

/** Older installed clients expect completed counts. Their waiter may disconnect;
 * the durable job remains independent and never reports uncompleted work as success. */
export async function legacySyncConnection(context: FinanceContext) {
  const requested = await requestSync(context);
  let job: SyncJobRow;
  if (!requested) return context.json({ error: "Connection not found." }, 404);
  job = requested;
  for (let poll = 0; poll < 100; poll++) {
    const current: SyncJobRow | null = await context.env.DB.prepare(
      "SELECT * FROM finance_sync_jobs WHERE id = ?",
    )
      .bind(job.id)
      .first<SyncJobRow>();
    if (!current) return context.json({ error: "Connection not found." }, 404);
    job = current;
    if (job.status === "succeeded")
      return respond(context, financeRoutes.syncConnection, {
        added: job.added,
        modified: job.modified,
        removed: job.removed,
      });
    if (job.error_code || job.status === "cancelled")
      return context.json(
        {
          code: job.error_code ?? "SYNC_CANCELLED",
          error: job.error_message ?? "Sync cancelled.",
        },
        502,
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return context.json(
    {
      error:
        "Sync continues in the background. Reopen the connection to check its status.",
    },
    503,
  );
}

export async function updateSyncSettings(context: FinanceContext) {
  const input = financeRoutes.updateSyncSettings.body.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!input.success)
    return context.json({ error: "dailySync must be a boolean." }, 400);
  const result = await context.env.DB.prepare(`UPDATE plaid_items
    SET daily_sync = ?, daily_sync_actor = ?, updated_at = ?
    WHERE id = ? AND organization_id = ? AND status IN ('active', 'error') RETURNING id`)
    .bind(
      input.data.dailySync ? 1 : 0,
      await financeSyncActor(context),
      new Date().toISOString(),
      context.req.param("id") ?? "",
      context.get("organizationId"),
    )
    .first();
  if (!result)
    return context.json(
      { error: "Connection not found or disconnected." },
      404,
    );
  return respond(context, financeRoutes.updateSyncSettings, input.data);
}
