import { formsRoutes } from "@balebase/validators/forms";
import { Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { activityBatch, activityStatement } from "../shared/activity";
import { respond } from "../shared/respond";
import {
  discardedFormError,
  discardRejection,
  findForm,
} from "./formRunRecords";

export const formRunDiscard = new Hono<ApiEnv>();

/** Discarding keeps the form readable in the Deleted view; it never changes again. */
formRunDiscard.delete("/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const form = await findForm(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!form) return context.json({ error: "Form not found." }, 404);
  const rejection = discardRejection(form);
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
          action: "form.discarded",
          actorId,
          details: {},
          occurredAt: now,
          organizationId,
          root: { id: form.id, label: form.template_name, type: "form_run" },
          subject: { id: form.id, type: "form_run" },
        },
        {
          bindings: [form.id, organizationId],
          sql: `EXISTS (
          SELECT 1 FROM forms
          WHERE id = ? AND organization_id = ? AND status = 'in_progress'
            AND deleted_at IS NULL
        )`,
        },
      ),
      context.env.DB.prepare(
        `UPDATE forms SET deleted_at = ?, deleted_by_user_id = ?
       WHERE id = ? AND organization_id = ? AND status = 'in_progress'
         AND deleted_at IS NULL`,
      ).bind(now, actorId, form.id, organizationId),
    ],
  );
  if (Number(discarded?.meta.changes) === 0) {
    const current = await findForm(context.env.DB, organizationId, form.id);
    if (!current) return context.json({ error: "Form not found." }, 404);
    return context.json(
      { error: discardRejection(current) ?? discardedFormError },
      409,
    );
  }
  return respond(context, formsRoutes.discardRun, { deletedAt: now });
});
