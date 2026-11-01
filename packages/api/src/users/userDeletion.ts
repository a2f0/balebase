import { accountSettingsRoutes } from "@balebase/validators/accountSettings";
import { Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { readBody, respond } from "../shared/respond";
import {
  maintenanceActor,
  type SystemActor,
  systemActivityRowsStatement,
} from "../shared/systemActivity";
import type { Bindings } from "../types";
import {
  cancelUserDeletion,
  requestUserDeletion,
} from "./userDeletionActivity";

export const userDeletion = new Hono<ApiEnv>();

userDeletion.get("/", async (context) => {
  const request = await context.env.DB.prepare(
    "SELECT requested_at AS requestedAt FROM user_deletion_requests WHERE user_id = ?",
  )
    .bind(context.get("authSession").user.id)
    .first<{ requestedAt: string }>();
  return respond(context, accountSettingsRoutes.deletion, {
    requestedAt: request?.requestedAt ?? null,
  });
});

userDeletion.post("/", async (context) => {
  if (context.req.header("Origin") !== context.env.CORS_ORIGIN) {
    return context.json({ error: "Untrusted request origin." }, 403);
  }
  const session = context.get("authSession");
  if (session.session.impersonatedBy) {
    return context.json(
      { error: "An impersonated session cannot request account deletion." },
      403,
    );
  }
  const input = await readBody(
    context,
    accountSettingsRoutes.requestDeletion,
    "Account deletion confirmation is required.",
  );
  if (input instanceof Response) return input;
  const userId = session.user.id;
  if (await requestUserDeletion(context.env.DB, userId, session.user)) {
    console.log({ event: "user_deletion_requested", actorUserId: userId });
  }
  return respond(context, accountSettingsRoutes.requestDeletion, { ok: true });
});

userDeletion.delete("/", async (context) => {
  if (context.req.header("Origin") !== context.env.CORS_ORIGIN) {
    return context.json({ error: "Untrusted request origin." }, 403);
  }
  const actor = context.get("authSession").user;
  if (context.get("authSession").session.impersonatedBy) {
    return context.json(
      { error: "An impersonated session cannot cancel account deletion." },
      403,
    );
  }
  if (await cancelUserDeletion(context.env.DB, actor.id, actor)) {
    console.log({ event: "user_deletion_canceled", actorUserId: actor.id });
  }
  return respond(context, accountSettingsRoutes.cancelDeletion, { ok: true });
});

/**
 * An account whose deletion request is past its 30-day window and that
 * nothing retained still needs. Unqualified columns are the user row's.
 */
const purgeableUser = `user.id = ? AND user.id NOT LIKE 'system:%'
  AND instr(',' || replace(COALESCE(user.role, ''), ' ', '') || ',', ',admin,') = 0
  AND EXISTS (SELECT 1 FROM user_deletion_requests
              WHERE user_id = user.id AND julianday(requested_at) <= julianday(?))
  AND NOT EXISTS (SELECT 1 FROM member JOIN organization ON organization.id = member.organizationId
                  WHERE member.userId = user.id AND organization.deletedAt IS NULL)
  AND NOT EXISTS (SELECT 1 FROM contracts
                  WHERE created_by = user.id OR sent_by = user.id)
  AND NOT EXISTS (SELECT 1 FROM contract_events WHERE actor_user_id = user.id)`;

/**
 * Purges accounts requested for deletion at least 30 days ago. Each purge
 * records `user.purged`, platform activity that root admins read, in the
 * transaction that deletes the account: when it was requested, and who asked
 * (a root admin by snapshot; the person themselves by ID only). It keeps
 * nothing else about the purged person.
 */
export async function purgeRequestedUsers(
  environment: Pick<Bindings, "DB">,
  runId: string,
  now = new Date(),
) {
  const actor = maintenanceActor("purgeRequestedUsers", runId);
  const cutoff = new Date(
    now.getTime() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const eligible = await environment.DB.prepare(
    `SELECT user_id FROM user_deletion_requests
     WHERE julianday(requested_at) <= julianday(?)
     ORDER BY last_attempted_at IS NOT NULL, last_attempted_at, requested_at, user_id LIMIT 25`,
  )
    .bind(cutoff)
    .all<{ user_id: string }>();
  let purged = 0;
  let blocked = 0;
  for (const { user_id: userId } of eligible.results) {
    await environment.DB.prepare(
      "UPDATE user_deletion_requests SET last_attempted_at = ? WHERE user_id = ?",
    )
      .bind(now.toISOString(), userId)
      .run();
    try {
      // Recheck the request atomically: cancellation must win if committed first.
      // Preserve contract attribution whose foreign keys otherwise become null.
      // Restrictive foreign keys protect the remaining financial/audit history.
      const [, deleted] = await environment.DB.batch<{ id: string }>([
        purgeRecord(environment.DB, actor, now, userId, cutoff),
        environment.DB.prepare(
          `DELETE FROM user WHERE ${purgeableUser} RETURNING id`,
        ).bind(userId, cutoff),
      ]);
      const result = deleted?.results[0];
      if (result) {
        purged += 1;
        console.log({ event: "user_purged", userId });
      } else {
        blocked += 1;
        console.log({ event: "user_purge_skipped", userId });
      }
    } catch (cause) {
      // A retained reference blocks this user, but should not block the next one.
      if (
        !(cause instanceof Error) ||
        !cause.message.includes("FOREIGN KEY constraint failed")
      )
        throw cause;
      blocked += 1;
      console.log({ event: "user_purge_blocked_by_retained_records", userId });
    }
  }
  return { purged, blocked };
}

function purgeRecord(
  database: D1Database,
  actor: SystemActor,
  now: Date,
  userId: string,
  cutoff: string,
) {
  const requester = `request.requested_by_user_id IS NOT NULL
    AND request.requested_by_user_id <> user.id`;
  return systemActivityRowsStatement(database, actor, now.toISOString(), {
    bindings: [userId, cutoff],
    sql: `SELECT NULL AS organization_id, 'user' AS root_type,
                 user.id AS root_id, user.id AS root_label,
                 'user' AS subject_type, user.id AS subject_id,
                 'user.purged' AS action,
                 json_object(
                   'requestedAt', request.requested_at,
                   'via', CASE
                     WHEN request.requested_by_user_id IS NULL THEN NULL
                     WHEN request.requested_by_user_id = user.id THEN 'self'
                     ELSE 'root_admin' END,
                   'requestedBy', request.requested_by_user_id,
                   'requestedByName',
                     CASE WHEN ${requester} THEN request.requested_by_name END,
                   'requestedByEmail',
                     CASE WHEN ${requester} THEN request.requested_by_email END
                 ) AS details
          FROM user
          JOIN user_deletion_requests AS request ON request.user_id = user.id
          WHERE ${purgeableUser}`,
  });
}
