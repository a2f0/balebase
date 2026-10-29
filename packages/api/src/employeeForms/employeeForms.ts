import {
  type EmployeeRequirementUpdate,
  employeeFormsRoutes,
} from "@balebase/validators/employeeForms";
import { Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import {
  canManage,
  requireManager,
} from "../organizations/organizationMembers";
import { readBody, respond } from "../shared/respond";
import { respondToUnexpectedError } from "../shared/unexpectedError";
import { CheckrRequestError } from "./checkr";
import { employeeFormDocuments } from "./employeeFormDocuments";
import {
  findRequirement,
  type RequirementRow,
  screeningActive,
  toRequirement,
} from "./employeeFormRecords";
import { employeeFormScreening } from "./employeeFormScreening";

const employeeForms = new Hono<ApiEnv>();

employeeForms.get("/", async (context) => {
  const organizationId = context.get("organizationId");
  // My documents lists only the person's own requests, as the person sees
  // them, even when they also manage the organization.
  const own = context.req.query("for") === "me";
  const manager = !own && canManage(context);
  const userId = context.get("authSession").user.id;
  const result = await context.env.DB.prepare(
    `SELECT requirement.id, requirement.kind, requirement.title,
            requirement.due_date, requirement.status, requirement.document_key,
            requirement.document_filename, requirement.document_size,
            requirement.document_revision,
            requirement.invitation_id, invitation.status AS invitation_status,
            requirement.member_id,
            requirement.completed_at, requirement.checkr_report_id,
            requirement.checkr_report_status, requirement.checkr_result,
            requirement.checkr_consent_id, requirement.checkr_requested_at,
            requirement.checkr_work_state, requirement.checkr_work_city,
            requirement.checkr_starting_at, requirement.checkr_start_nonce,
            requirement.checkr_refresh_revision,
            COALESCE(target.email, invitation.email, requirement.target_email)
              AS target_email,
            target.name AS target_name,
            COALESCE(member.userId = ?, 0) AS is_subject
     FROM employee_requirements AS requirement
     LEFT JOIN member ON member.id = requirement.member_id
     LEFT JOIN user AS target ON target.id = member.userId
     LEFT JOIN invitation ON invitation.id = requirement.invitation_id
     WHERE requirement.organization_id = ?
       AND (${manager ? "1 = 1" : "member.userId = ?"})
     ORDER BY requirement.due_date ASC, requirement.created_at ASC`,
  )
    .bind(
      ...(manager
        ? [userId, organizationId]
        : [userId, organizationId, userId]),
    )
    .all<RequirementRow>();
  return respond(context, employeeFormsRoutes.list, {
    requirements: result.results.map((row) =>
      toRequirement(row, manager, context.env),
    ),
  });
});

employeeForms.post("/", requireManager(), async (context) => {
  const body = await readBody(
    context,
    employeeFormsRoutes.create,
    "A target and requirements are required.",
  );
  if (body instanceof Response) return body;
  const memberId = body.memberId || null;
  const invitationId = body.invitationId || null;
  const organizationId = context.get("organizationId");
  const target = await context.env.DB.prepare(
    memberId
      ? `SELECT user.email, user.id AS user_id
         FROM member JOIN user ON user.id = member.userId
         WHERE member.id = ? AND member.organizationId = ?`
      : `SELECT email, NULL AS user_id FROM invitation
         WHERE id = ? AND organizationId = ? AND status = 'pending'`,
  )
    .bind(memberId ?? invitationId, organizationId)
    .first<{ email: string; user_id: string | null }>();
  if (!target) return context.json({ error: "Person not found." }, 404);

  const now = new Date().toISOString();
  const { requirements } = body;
  const ids = requirements.map(() => crypto.randomUUID());
  const inserted = await context.env.DB.batch(
    requirements.map((requirement, index) =>
      context.env.DB.prepare(
        `INSERT INTO employee_requirements
         (id, organization_id, invitation_id, member_id, target_email,
          assigned_user_id,
          kind, title, due_date, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM ${memberId ? "member" : "invitation"}
           WHERE id = ? AND organizationId = ?
             ${memberId ? "" : "AND status = 'pending'"}
         )`,
      ).bind(
        ids[index],
        organizationId,
        invitationId,
        memberId,
        target.email.toLowerCase(),
        target.user_id,
        requirement.kind,
        requirement.title,
        requirement.dueDate,
        now,
        now,
        memberId ?? invitationId,
        organizationId,
      ),
    ),
  );
  if (inserted.some((result) => !result.meta.changes)) {
    return context.json(
      { error: "The invitation or membership changed. Please try again." },
      409,
    );
  }
  return respond(context, employeeFormsRoutes.create, { ids }, 201);
});

employeeForms.patch("/:id", requireManager(), async (context) => {
  const row = await findRequirement(context);
  if (!row) return context.json({ error: "Requirement not found." }, 404);
  const body = await readBody(
    context,
    employeeFormsRoutes.update,
    "Invalid status or due date.",
  );
  if (body instanceof Response) return body;
  const { dueDate, status } = body;
  if (!isValidRequirementUpdate(row, body)) {
    return context.json({ error: "Invalid status or due date." }, 400);
  }
  const now = new Date().toISOString();
  const updated = await context.env.DB.prepare(
    `UPDATE employee_requirements
     SET status = COALESCE(?, status), due_date = COALESCE(?, due_date),
         completed_at = CASE
           WHEN ? IS NULL THEN completed_at
           WHEN ? = 'complete' THEN ?
           ELSE NULL
         END,
         checkr_refresh_revision = checkr_refresh_revision +
           CASE WHEN ? IS NOT NULL AND kind <> 'form' THEN 1 ELSE 0 END,
         updated_at = ?
     WHERE id = ? AND organization_id = ?
       AND (? IS NULL OR kind <> 'form' OR document_revision = ?)
       AND (? IS NULL OR checkr_report_id IS NULL OR
            checkr_report_status IN ('canceled', 'partially_canceled'))
       AND (? IS NULL OR
            (checkr_starting_at IS NULL AND checkr_start_nonce IS NULL))`,
  )
    .bind(
      status ?? null,
      dueDate ?? null,
      status ?? null,
      status ?? null,
      now,
      status ?? null,
      now,
      row.id,
      context.get("organizationId"),
      status ?? null,
      body.documentRevision ?? null,
      status ?? null,
      status ?? null,
    )
    .run();
  if (!updated.meta.changes) {
    return context.json({ error: "The form changed. Please try again." }, 409);
  }
  return respond(context, employeeFormsRoutes.update, { ok: true });
});

employeeForms.delete("/:id", requireManager(), async (context) => {
  const row = await findRequirement(context);
  if (!row) return context.json({ error: "Requirement not found." }, 404);
  if (screeningActive(row)) {
    return context.json(
      { error: "An ordered Checkr screening cannot be removed." },
      409,
    );
  }
  const deleted = await context.env.DB.prepare(
    `DELETE FROM employee_requirements
     WHERE id = ? AND organization_id = ? AND checkr_starting_at IS NULL
       AND checkr_start_nonce IS NULL
       AND (checkr_report_id IS NULL OR
            checkr_report_status IN ('canceled', 'partially_canceled'))`,
  )
    .bind(row.id, context.get("organizationId"))
    .run();
  if (!deleted.meta.changes) {
    return context.json(
      { error: "Screening is changing. Try again later." },
      409,
    );
  }
  return respond(context, employeeFormsRoutes.delete, { ok: true });
});

employeeForms.route("/", employeeFormDocuments);
employeeForms.route("/", employeeFormScreening);

employeeForms.onError((error, context) => {
  if (error instanceof CheckrRequestError) {
    console.error(error);
    return context.json({ error: error.message }, 502);
  }
  return respondToUnexpectedError(error, context);
});

/** Whether the requirement, as it is now, can take the update's status. */
function isValidRequirementUpdate(
  row: RequirementRow,
  { documentRevision, status }: EmployeeRequirementUpdate,
) {
  return !(
    (row.kind === "form" && status === "in_progress") ||
    (row.kind !== "form" && status === "submitted") ||
    (row.kind === "form" && status === "complete" && !row.document_key) ||
    (row.kind === "form" &&
      status !== undefined &&
      documentRevision === undefined) ||
    (status !== undefined && screeningActive(row))
  );
}

export { employeeForms };
