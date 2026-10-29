import { auditsRoutes } from "@balebase/validators/audits";
import { Hono } from "hono";
import type { ApiEnv } from "../auth/authMiddleware";
import { activityBatch, activityStatement } from "../shared/activity";
import { respond } from "../shared/respond";
import {
  discardedAuditError,
  discardRejection,
  findAudit,
} from "./auditRunRecords";

export const auditRunDiscard = new Hono<ApiEnv>();

/** Discarding keeps the audit readable in the Deleted view; it never changes again. */
auditRunDiscard.delete("/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const audit = await findAudit(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!audit) return context.json({ error: "Audit not found." }, 404);
  const rejection = discardRejection(audit);
  if (rejection) return context.json({ error: rejection }, 409);
  const actorId = context.get("authSession").user.id;
  const now = new Date().toISOString();
  // The event goes first under the update's own predicate: a batch is one
  // transaction, so a concurrent discard can never record a second event.
  const [, discarded] = await activityBatch(
    context.env.DB,
    context.get("apiKey"),
    [
      activityStatement(
        context.env.DB,
        {
          action: "audit.discarded",
          actorId,
          details: {},
          occurredAt: now,
          organizationId,
          root: { id: audit.id, label: audit.template_name, type: "audit_run" },
          subject: { id: audit.id, type: "audit_run" },
        },
        {
          bindings: [audit.id, organizationId],
          sql: `EXISTS (
          SELECT 1 FROM audits
          WHERE id = ? AND organization_id = ? AND status = 'in_progress'
            AND deleted_at IS NULL
        )`,
        },
      ),
      context.env.DB.prepare(
        `UPDATE audits SET deleted_at = ?, deleted_by_user_id = ?
       WHERE id = ? AND organization_id = ? AND status = 'in_progress'
         AND deleted_at IS NULL`,
      ).bind(now, actorId, audit.id, organizationId),
    ],
  );
  if (Number(discarded?.meta.changes) === 0) {
    const current = await findAudit(context.env.DB, organizationId, audit.id);
    if (!current) return context.json({ error: "Audit not found." }, 404);
    return context.json(
      { error: discardRejection(current) ?? discardedAuditError },
      409,
    );
  }
  return respond(context, auditsRoutes.discardRun, { deletedAt: now });
});
