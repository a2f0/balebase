import { accountSettingsRoutes } from "@balebase/validators/accountSettings";
import { Hono } from "hono";
import type { ApiEnv } from "./authMiddleware";
import { readBody, respond } from "./shared/respond";
import type { Bindings } from "./types";
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

export async function purgeRequestedUsers(
  environment: Pick<Bindings, "DB">,
  now = new Date(),
) {
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
      const result = await environment.DB.prepare(
        `DELETE FROM user WHERE id = ? AND id NOT LIKE 'system:%'
         AND instr(',' || replace(COALESCE(role, ''), ' ', '') || ',', ',admin,') = 0
         AND EXISTS (SELECT 1 FROM user_deletion_requests
                     WHERE user_id = user.id AND julianday(requested_at) <= julianday(?))
         AND NOT EXISTS (SELECT 1 FROM member JOIN organization ON organization.id = member.organizationId
                         WHERE member.userId = user.id AND organization.deletedAt IS NULL)
         AND NOT EXISTS (SELECT 1 FROM contracts
                         WHERE created_by = user.id OR sent_by = user.id)
         AND NOT EXISTS (SELECT 1 FROM contract_events WHERE actor_user_id = user.id)
         RETURNING id`,
      )
        .bind(userId, cutoff)
        .first<{ id: string }>();
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
