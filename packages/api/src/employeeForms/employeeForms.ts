import {
  type EmployeeRequirementUpdate,
  employeeFormsRoutes,
} from "@balebase/validators/employeeForms";
import { Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import {
  canManage,
  requireManager,
  stillManages,
} from "../organizations/organizationMembers";
import { activityBatch, findActivity, requestActor } from "../shared/activity";
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
import {
  jsonBoolean,
  requirementActivityStatement,
} from "./requirementActivity";

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
  const actor = requestActor(context);
  const manages = stillManages(organizationId, actor.userId);
  const database = context.env.DB;
  // Each request is recorded as it was assigned; a manager demoted meanwhile
  // assigns nothing.
  const inserted = await activityBatch(
    database,
    actor.apiKey,
    requirements.flatMap((requirement, index) => [
      database
        .prepare(
          `INSERT INTO employee_requirements
           (id, organization_id, invitation_id, member_id, target_email,
            assigned_user_id,
            kind, title, due_date, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM ${memberId ? "member" : "invitation"}
             WHERE id = ? AND organizationId = ?
               ${memberId ? "" : "AND status = 'pending'"}
           ) AND ${manages.sql}`,
        )
        .bind(
          ids[index] ?? "",
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
          ...manages.bindings,
        ),
      requirementActivityStatement(database, {
        action: "employee_requirement.assigned",
        actorId: actor.userId,
        details: {
          bindings: [],
          sql: `'dueDate', due_date,
            'invited', ${jsonBoolean("invitation_id IS NOT NULL")}`,
        },
        organizationId,
        requirementId: ids[index] ?? "",
      }),
    ]),
  );
  if (
    inserted.some((result, index) => index % 2 === 0 && !result.meta.changes)
  ) {
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
  const organizationId = context.get("organizationId");
  const actor = requestActor(context);
  const manages = stillManages(organizationId, actor.userId);
  const guard = {
    bindings: [
      row.id,
      organizationId,
      status ?? null,
      body.documentRevision ?? null,
      status ?? null,
      status ?? null,
      ...manages.bindings,
    ],
    sql: `id = ? AND organization_id = ?
       AND (? IS NULL OR kind <> 'form' OR document_revision = ?)
       AND (? IS NULL OR checkr_report_id IS NULL OR
            checkr_report_status IN ('canceled', 'partially_canceled'))
       AND (? IS NULL OR
            (checkr_starting_at IS NULL AND checkr_start_nonce IS NULL))
       AND ${manages.sql}`,
  };
  const database = context.env.DB;
  // Each event reads the value it replaces under the update's own guard, and
  // only when the value changes.
  const results = await activityBatch(database, actor.apiKey, [
    requirementActivityStatement(
      database,
      {
        action: "employee_requirement.status_changed",
        actorId: actor.userId,
        details: {
          bindings: [status ?? null],
          sql: `'before', status, 'after', ?,
            'checkrReport', ${jsonBoolean("checkr_report_id IS NOT NULL")}`,
        },
        organizationId,
        requirementId: row.id,
      },
      {
        bindings: [...guard.bindings, status ?? null, status ?? null],
        sql: `${guard.sql} AND ? IS NOT NULL AND status IS NOT ?`,
      },
    ),
    requirementActivityStatement(
      database,
      {
        action: "employee_requirement.due_date_changed",
        actorId: actor.userId,
        details: {
          bindings: [dueDate ?? null],
          sql: "'before', due_date, 'after', ?",
        },
        organizationId,
        requirementId: row.id,
      },
      {
        bindings: [...guard.bindings, dueDate ?? null, dueDate ?? null],
        sql: `${guard.sql} AND ? IS NOT NULL AND due_date IS NOT ?`,
      },
    ),
    database
      .prepare(
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
         WHERE ${guard.sql}`,
      )
      .bind(
        status ?? null,
        dueDate ?? null,
        status ?? null,
        status ?? null,
        now,
        status ?? null,
        now,
        ...guard.bindings,
      ),
  ]);
  if (!results.at(-1)?.meta.changes) {
    return context.json({ error: "The form changed. Please try again." }, 409);
  }
  return respond(context, employeeFormsRoutes.update, { ok: true });
});

// One request's history, for managers only, as the workspace feed's
// requested forms and checks are; the person never reads it.
employeeForms.get("/:id/activity", requireManager(), async (context) => {
  const row = await findRequirement(context);
  if (!row) return context.json({ error: "Requirement not found." }, 404);
  const page = await findActivity(
    context.env.DB,
    context.get("organizationId"),
    context.req.query("cursor"),
    { id: row.id, type: "employee_requirement" },
    false,
    undefined,
    true,
  );
  return page
    ? respond(context, employeeFormsRoutes.activity, page)
    : context.json({ error: "Invalid activity cursor." }, 400);
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
  const organizationId = context.get("organizationId");
  const actor = requestActor(context);
  const manages = stillManages(organizationId, actor.userId);
  const guard = {
    bindings: [row.id, organizationId, ...manages.bindings],
    sql: `id = ? AND organization_id = ? AND checkr_starting_at IS NULL
       AND checkr_start_nonce IS NULL
       AND (checkr_report_id IS NULL OR
            checkr_report_status IN ('canceled', 'partially_canceled'))
       AND ${manages.sql}`,
  };
  const database = context.env.DB;
  // The person's signed screening authorizations go with the requirement;
  // the event keeps only how many there were.
  const results = await activityBatch(database, actor.apiKey, [
    requirementActivityStatement(
      database,
      {
        action: "employee_requirement.deleted",
        actorId: actor.userId,
        details: {
          bindings: [],
          sql: `'status', status, 'dueDate', due_date,
            'checkrReport', ${jsonBoolean("checkr_report_id IS NOT NULL")},
            'consentsRemoved', (SELECT COUNT(*) FROM employee_screening_consents
              WHERE requirement_id = employee_requirements.id)`,
        },
        organizationId,
        requirementId: row.id,
      },
      guard,
    ),
    database
      .prepare(`DELETE FROM employee_requirements WHERE ${guard.sql}`)
      .bind(...guard.bindings),
  ]);
  if (!results.at(-1)?.meta.changes) {
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
