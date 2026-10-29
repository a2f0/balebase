import { auditsRoutes } from "@balebase/validators/audits";
import { Hono } from "hono";
import { deletePendingAuditIssueObject } from "./auditIssueImageCleanup";
import { findAuditIssueImage } from "./auditIssueImageRecords";
import { discardedAuditError, imageAuditNotDiscarded } from "./auditRunRecords";
import type { ApiEnv } from "./authMiddleware";
import { activityBatch, activityStatement } from "./shared/activity";
import { respond } from "./shared/respond";

export const auditIssueImageRemoval = new Hono<ApiEnv>();

auditIssueImageRemoval.delete("/:issueId/images/:imageId", async (context) => {
  const organizationId = context.get("organizationId");
  const row = await findAuditIssueImage(
    context.env.DB,
    organizationId,
    context.req.param("issueId"),
    context.req.param("imageId"),
    true,
  );
  if (!row) return context.json({ error: "Issue image not found." }, 404);
  if (row.audit_deleted_at) {
    return context.json({ error: discardedAuditError }, 409);
  }
  // Atomically hide the image and release its unique issue slot before R2
  // cleanup. A failed R2 delete leaves a durable object tombstone for cron.
  // Each statement rechecks the discard, so one after the read keeps the image.
  const [, hidden] = await activityBatch(
    context.env.DB,
    context.get("apiKey"),
    [
      activityStatement(
        context.env.DB,
        {
          action: "audit.image_removed",
          actorId: context.get("authSession").user.id,
          details: {
            filename: row.filename,
            issueId: row.issue_id,
            title: row.title,
          },
          occurredAt: new Date().toISOString(),
          organizationId,
          root: {
            id: row.audit_id,
            label: row.template_name,
            type: row.target_type === "workspace" ? "issue" : "audit_run",
          },
          subject: { id: row.id, type: "audit_issue_image" },
        },
        {
          bindings: [row.id, row.object_id, organizationId, row.id],
          sql: `EXISTS (
        SELECT 1 FROM audit_issue_images AS image
        JOIN objects AS object ON object.id = image.object_id
        WHERE image.id = ? AND object.id = ? AND object.organization_id = ?
          AND object.deletion_pending = 0
      ) AND ${imageAuditNotDiscarded}`,
        },
      ),
      context.env.DB.prepare(
        `UPDATE objects
       SET deletion_pending = 1, cleanup_token = NULL,
           cleanup_claimed_at = NULL, upload_token = NULL,
           upload_lease_expires_at = NULL
       WHERE id = ? AND organization_id = ? AND kind = 'audit_issue_image'
         AND ${imageAuditNotDiscarded}`,
      ).bind(row.object_id, organizationId, row.id),
      context.env.DB.prepare(
        `DELETE FROM audit_issue_images
       WHERE id = ? AND object_id = ? AND ${imageAuditNotDiscarded}`,
      ).bind(row.id, row.object_id, row.id),
    ],
  );
  if (Number(hidden?.meta.changes) === 0) {
    const current = await findAuditIssueImage(
      context.env.DB,
      organizationId,
      row.issue_id,
      row.id,
      true,
    );
    return current?.audit_deleted_at
      ? context.json({ error: discardedAuditError }, 409)
      : context.json({ error: "Issue image not found." }, 404);
  }
  try {
    await deletePendingAuditIssueObject(context.env, {
      id: row.object_id,
    });
  } catch {
    return respond(
      context,
      auditsRoutes.deleteIssueImage,
      { cleanupPending: true },
      202,
    );
  }
  return context.body(null, 204);
});
