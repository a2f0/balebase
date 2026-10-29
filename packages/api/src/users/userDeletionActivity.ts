interface Actor {
  id: string;
  name: string;
  email: string;
}

export async function requestUserDeletion(
  database: D1Database,
  userId: string,
  actor: Actor,
  adminRequest = false,
) {
  const requestedAt = new Date().toISOString();
  const requestId = crypto.randomUUID();
  const [result] = await database.batch([
    database
      .prepare(
        `INSERT INTO user_deletion_requests
         (user_id, request_id, requested_at, requested_by_user_id, requested_by_name, requested_by_email)
       SELECT id, ?, ?, ?, ?, ? FROM user WHERE id = ?
         AND (? = 0 OR (id != ? AND id NOT LIKE 'system:%'
           AND instr(',' || replace(COALESCE(role, ''), ' ', '') || ',', ',admin,') = 0))
       ON CONFLICT(user_id) DO NOTHING`,
      )
      .bind(
        requestId,
        requestedAt,
        actor.id,
        actor.name,
        actor.email,
        userId,
        adminRequest ? 1 : 0,
        actor.id,
      ),
    // A unique request ID keeps retries and same-millisecond requests from
    // recording an event for an earlier request.
    database
      .prepare(
        `INSERT INTO user_deletion_events
         (id, user_id, action, occurred_at, requested_at, actor_user_id, actor_name, actor_email)
       SELECT ?, ?, 'requested', ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM user_deletion_requests WHERE user_id = ? AND request_id = ?)`,
      )
      .bind(
        requestId,
        userId,
        requestedAt,
        requestedAt,
        actor.id,
        actor.name,
        actor.email,
        userId,
        requestId,
      ),
  ]);
  return result?.meta.changes ? requestedAt : null;
}

export async function cancelUserDeletion(
  database: D1Database,
  userId: string,
  actor: Actor,
) {
  const [, result] = await database.batch([
    database
      .prepare(
        `INSERT INTO user_deletion_events
         (id, user_id, action, occurred_at, requested_at, actor_user_id, actor_name, actor_email)
       SELECT ?, user_id, 'canceled', ?, requested_at, ?, ?, ?
       FROM user_deletion_requests WHERE user_id = ?`,
      )
      .bind(
        crypto.randomUUID(),
        new Date().toISOString(),
        actor.id,
        actor.name,
        actor.email,
        userId,
      ),
    database
      .prepare("DELETE FROM user_deletion_requests WHERE user_id = ?")
      .bind(userId),
  ]);
  return Boolean(result?.meta.changes);
}
