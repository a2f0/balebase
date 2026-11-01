import type { AdminUserHistoryEvent } from "@balebase/validators/adminUsers";
import {
  cursorPage,
  decodeCursor,
  encodeCursor,
} from "../shared/cursorPagination";

const pageSize = 50;

interface UserHistoryRow {
  action: AdminUserHistoryEvent["action"];
  actor_email: string;
  actor_kind: "operator" | "user";
  actor_name: string;
  actor_user_id: string | null;
  new_role: string | null;
  occurred_at: string;
  previous_role: string | null;
  requested_at: string | null;
  uid: string;
}

interface MaintenanceRequestRow {
  actor_email: string;
  actor_name: string;
  actor_user_id: string;
  id: string;
  job_id: string;
  joined_active_run: number;
  requested_at: string;
  run_id: string;
}

/**
 * One person's platform role changes (`user_role_events`) and account
 * deletion requests and cancellations (`user_deletion_events`), newest first.
 * Actors are the snapshots taken when the change was made. Null for a bad
 * cursor.
 */
export async function listUserHistory(
  database: D1Database,
  userId: string,
  cursor: string | undefined,
) {
  const boundary =
    cursor === undefined ? null : decodeCursor(cursor, "createdAt", 500);
  if (cursor !== undefined && !boundary) return null;
  const { results } = await database
    .prepare(
      `SELECT * FROM (
         SELECT 'role:' || id AS uid, action, occurred_at, previous_role,
                new_role, NULL AS requested_at, actor_kind, actor_user_id,
                actor_name, actor_email
         FROM user_role_events WHERE user_id = ?
         UNION ALL
         SELECT 'deletion:' || id, 'deletion_' || action, occurred_at, NULL,
                NULL, requested_at, 'user', actor_user_id, actor_name,
                actor_email
         FROM user_deletion_events WHERE user_id = ?
       )
       ${boundary ? "WHERE (occurred_at, uid) < (?, ?)" : ""}
       ORDER BY occurred_at DESC, uid DESC LIMIT ?`,
    )
    .bind(userId, userId, ...(boundary ?? []), pageSize + 1)
    .all<UserHistoryRow>();
  const page = cursorPage(results, pageSize, (row) =>
    encodeCursor(row.occurred_at, row.uid),
  );
  return {
    events: page.items.map(
      (row): AdminUserHistoryEvent => ({
        action: row.action,
        actor: {
          email: row.actor_email,
          id: row.actor_user_id,
          kind: row.actor_kind,
          name: row.actor_name,
        },
        id: row.uid,
        newRole: row.new_role,
        occurredAt: row.occurred_at,
        previousRole: row.previous_role,
        requestedAt: row.requested_at,
      }),
    ),
    nextCursor: page.nextCursor,
  };
}

/**
 * Every manual maintenance request (`maintenance_requests`), newest first,
 * including ones that joined an active run, with the requester's snapshot.
 * Null for a bad cursor.
 */
export async function listMaintenanceRequests(
  database: D1Database,
  query: { cursor?: string | undefined; jobId?: string | undefined },
) {
  const conditions: string[] = [];
  const values: string[] = [];
  if (query.jobId) {
    conditions.push("job_id = ?");
    values.push(query.jobId);
  }
  if (query.cursor !== undefined) {
    const boundary = decodeCursor(query.cursor, "createdAt", 500);
    if (!boundary) return null;
    conditions.push("(requested_at, id) < (?, ?)");
    values.push(...boundary);
  }
  const { results } = await database
    .prepare(
      `SELECT * FROM maintenance_requests
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY requested_at DESC, id DESC LIMIT ?`,
    )
    .bind(...values, pageSize + 1)
    .all<MaintenanceRequestRow>();
  const page = cursorPage(results, pageSize, (row) =>
    encodeCursor(row.requested_at, row.id),
  );
  return {
    nextCursor: page.nextCursor,
    requests: page.items.map((row) => ({
      actor: {
        email: row.actor_email,
        id: row.actor_user_id,
        name: row.actor_name,
      },
      id: row.id,
      jobId: row.job_id,
      joinedActiveRun: Boolean(row.joined_active_run),
      requestedAt: row.requested_at,
      runId: row.run_id,
    })),
  };
}
