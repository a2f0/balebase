import {
  type EmployeeRequirement,
  type EmployeeRequirementKind,
  type EmployeeRequirementStatus,
  type EmployeeRequirementUpdate,
  employeeFormsRoutes,
  screeningMessages,
} from "@balebase/validators/employeeForms";
import { type Context, Hono } from "hono";
import type { ApiEnv } from "../auth/authMiddleware";
import {
  canManage,
  requireManager,
} from "../organizations/organizationMembers";
import { normalizeFilename } from "../shared/filenames";
import { readBody, respond } from "../shared/respond";
import {
  readBoundedForm,
  storedDownload,
  trackedPut,
  uploadStillQueued,
} from "../shared/storage";
import { respondToUnexpectedError } from "../shared/unexpectedError";
import type { Bindings } from "../types";
import {
  CheckrRequestError,
  checkrConfigured,
  checkrPackage,
  checkrPackageScreenings,
  checkrTestMode,
} from "./checkr";
import {
  isClosedReportStatus,
  refreshCheckrScreening,
  requestCheckrScreening,
  submitCheckrScreening,
} from "./checkrScreening";
import { checkrTestCandidates } from "./checkrTestCandidates";
import {
  disclosureFingerprint,
  screeningDisclosures,
  summaryOfRightsUrl,
} from "./screeningDisclosures";
import { sendScreeningRequest } from "./screeningMail";
import { parseScreeningSubmission } from "./screeningSubmission";

interface RequirementRow {
  id: string;
  kind: EmployeeRequirementKind;
  title: string;
  due_date: string;
  status: EmployeeRequirementStatus;
  document_key: string | null;
  document_filename: string | null;
  document_size: number | null;
  document_revision: number;
  invitation_id: string | null;
  invitation_status: string | null;
  member_id: string | null;
  target_email: string | null;
  target_name: string | null;
  completed_at: string | null;
  checkr_report_id: string | null;
  checkr_report_status: string | null;
  checkr_result: string | null;
  checkr_consent_id: string | null;
  checkr_requested_at: string | null;
  checkr_work_state: string | null;
  checkr_work_city: string | null;
  checkr_starting_at: string | null;
  checkr_start_nonce: string | null;
  checkr_refresh_revision: number;
  /** Listing only: the requirement belongs to the signed-in person. */
  is_subject?: number;
}

const employeeForms = new Hono<ApiEnv>();
const maxDocumentBytes = 10 * 1024 * 1024;
const documentTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);

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

employeeForms.post("/:id/document", async (context) => {
  const row = await findRequirement(context);
  if (!row || !(await canAccessRequirement(context, row))) {
    return context.json({ error: "Requirement not found." }, 404);
  }
  if (row.kind !== "form") {
    return context.json({ error: "Only forms accept documents." }, 400);
  }
  const form = await readBoundedForm(context.req.raw, maxDocumentBytes);
  if (form === "too_large") {
    return context.json({ error: "Files must be 10 MB or smaller." }, 413);
  }
  const file = form?.get("file");
  if (!(file instanceof File) || !documentTypes.has(file.type)) {
    return context.json({ error: "Choose a PDF, JPEG, or PNG file." }, 400);
  }
  if (!file.size || file.size > maxDocumentBytes) {
    return context.json({ error: "Files must be 10 MB or smaller." }, 413);
  }
  const key = `organizations/${context.get("organizationId")}/employee-forms/${row.id}/${crypto.randomUUID()}`;
  const filename = normalizeFilename(file.name, "form", 200);
  try {
    await trackedPut(
      context.env,
      {
        cleanupId: `employee-form-upload:${crypto.randomUUID()}`,
        key,
        organizationId: context.get("organizationId"),
      },
      file,
      { httpMetadata: { contentType: file.type } },
    );
    const updated = await context.env.DB.prepare(
      `UPDATE employee_requirements
       SET document_key = ?, document_filename = ?, document_size = ?,
           document_revision = document_revision + 1,
           status = 'submitted', completed_at = NULL, updated_at = ?
       WHERE id = ? AND organization_id = ? AND document_key IS ?
         AND ${uploadStillQueued}
         AND (? = 1 OR EXISTS (
           SELECT 1 FROM member WHERE member.id = employee_requirements.member_id
             AND member.organizationId = ? AND member.userId = ?
         ))`,
    )
      .bind(
        key,
        filename,
        file.size,
        new Date().toISOString(),
        row.id,
        context.get("organizationId"),
        row.document_key,
        key,
        canManage(context) ? 1 : 0,
        context.get("organizationId"),
        context.get("authSession").user.id,
      )
      .run();
    if (!updated.meta.changes) {
      await context.env.STORAGE.delete(key).catch(console.error);
      return context.json(
        { error: "The form changed. Please try again." },
        409,
      );
    }
  } catch (cause) {
    const linked = await context.env.DB.prepare(
      `SELECT document_key FROM employee_requirements
       WHERE id = ? AND organization_id = ?`,
    )
      .bind(row.id, context.get("organizationId"))
      .first<{ document_key: string | null }>();
    if (linked?.document_key === key) {
      return respond(context, employeeFormsRoutes.upload, {
        filename,
        status: "submitted",
      });
    }
    await context.env.STORAGE.delete(key).catch(console.error);
    throw cause;
  }
  return respond(context, employeeFormsRoutes.upload, {
    filename,
    status: "submitted",
  });
});

employeeForms.get("/:id/document", async (context) => {
  const row = await findRequirement(context);
  if (
    !row ||
    !(await canAccessRequirement(context, row)) ||
    !row.document_key
  ) {
    return context.json({ error: "Document not found." }, 404);
  }
  const download = await storedDownload(context.env.STORAGE, row.document_key, {
    fallbackFilename: "document",
    filename: row.document_filename ?? "document",
    headers: {
      "cache-control": "private, no-store",
      "x-document-revision": String(row.document_revision),
    },
  });
  return download ?? context.json({ error: "Document not found." }, 404);
});

employeeForms.post("/:id/checkr/request", requireManager(), async (context) => {
  const row = await findRequirement(context);
  if (
    row?.kind !== "background_check" ||
    !(row.member_id || row.invitation_status === "pending")
  ) {
    return context.json({ error: "Screening requirement not found." }, 404);
  }
  if (!checkrConfigured(context.env, row.kind)) {
    return context.json(
      { error: "Checkr is not configured for this screening." },
      503,
    );
  }
  const body = await readBody(
    context,
    employeeFormsRoutes.requestScreening,
    "A US work state and optional city are required.",
  );
  if (body instanceof Response) return body;
  if (screeningActive(row)) {
    return context.json(
      { error: "This screening was already submitted to Checkr." },
      409,
    );
  }
  const requested = await requestCheckrScreening(
    context.env.DB,
    context.get("organizationId"),
    row.id,
    body.state,
    body.city ?? null,
  );
  if (!requested) {
    return context.json(
      { error: "Screening is changing. Try again later." },
      409,
    );
  }
  const emailed = await emailScreeningRequest(context, row).then(
    () => true,
    (cause: unknown) => {
      console.error("Could not email a background check request.", cause);
      return false;
    },
  );
  return respond(context, employeeFormsRoutes.requestScreening, { emailed });
});

// The person's own screening form: the disclosures to read, the work
// location, and, while Checkr is in staging, its mocked test candidates.
employeeForms.get("/:id/checkr/form", async (context) => {
  if (!signedInAsSelf(context)) return signInRequired(context);
  const subject = await findScreeningSubject(context);
  if (!subject) {
    return context.json({ error: "Screening requirement not found." }, 404);
  }
  const packageSlug = checkrPackage(context.env);
  if (!checkrConfigured(context.env, subject.kind) || !packageSlug) {
    return context.json(
      { error: "Checkr is not configured for this screening." },
      503,
    );
  }
  if (!awaitingSubmission(subject)) {
    return context.json(
      { error: "This background check is not waiting for your details." },
      409,
    );
  }
  // Without the package's screenings, the license stays optional and Checkr
  // reports it missing if a driving record search needs it.
  const screenings = await checkrPackageScreenings(
    context.env,
    packageSlug,
  ).catch((cause: unknown) => {
    console.error("Could not read the Checkr package.", cause);
    return null;
  });
  const disclosures = screeningDisclosures(subject.organization_name);
  return respond(context, employeeFormsRoutes.screeningForm, {
    candidate: { email: subject.email, name: subject.name },
    disclosureFingerprint: await disclosureFingerprint(disclosures),
    disclosures,
    organizationName: subject.organization_name,
    requestRevision: subject.checkr_requested_at,
    requiresDriverLicense:
      screenings?.includes("motor_vehicle_report") ?? false,
    summaryOfRightsUrl,
    testCandidates: checkrTestMode(context.env) ? checkrTestCandidates : null,
    title: subject.title,
    workLocation: {
      city: subject.checkr_work_city,
      state: subject.checkr_work_state,
    },
  });
});

employeeForms.post("/:id/checkr/submit", async (context) => {
  // Only the person may sign for themselves: not an API key acting as its
  // creator, nor an admin impersonating them.
  if (!signedInAsSelf(context)) return signInRequired(context);
  const subject = await findScreeningSubject(context);
  if (!subject) {
    return context.json({ error: "Screening requirement not found." }, 404);
  }
  const packageSlug = checkrPackage(context.env);
  if (!checkrConfigured(context.env, subject.kind) || !packageSlug) {
    return context.json(
      { error: "Checkr is not configured for this screening." },
      503,
    );
  }
  if (!awaitingSubmission(subject) || !subject.checkr_work_state) {
    return context.json(
      { error: "This background check is not waiting for your details." },
      409,
    );
  }
  const body = await readBody(
    context,
    employeeFormsRoutes.submitScreening,
    "Complete the screening form.",
  );
  if (body instanceof Response) return body;
  // The person authorizes the request their form showed, not a newer one.
  if (body.requestRevision !== subject.checkr_requested_at) {
    return context.json({ error: screeningMessages.requestChanged }, 409);
  }
  const disclosures = screeningDisclosures(subject.organization_name);
  const submission = parseScreeningSubmission(
    body,
    subject.checkr_work_state,
    new Date().toISOString().slice(0, 10),
    await disclosureFingerprint(disclosures),
  );
  if ("error" in submission) {
    return context.json({ error: submission.error }, 400);
  }
  const result = await submitCheckrScreening(
    context.env,
    {
      disclosures,
      email: subject.email,
      organizationId: context.get("organizationId"),
      organizationName: subject.organization_name,
      packageSlug,
      requestedAt: subject.checkr_requested_at ?? "",
      requirementId: subject.id,
      requirementTitle: subject.title,
      userId: subject.user_id,
      workCity: subject.checkr_work_city,
      workState: subject.checkr_work_state,
    },
    submission,
    {
      ipAddress: context.req.header("cf-connecting-ip") ?? null,
      userAgent: context.req.header("user-agent") ?? null,
    },
  );
  if (result.kind === "conflict") {
    return context.json({ error: result.message }, 409);
  }
  if (result.kind === "rejected") {
    return context.json({ error: result.message }, 422);
  }
  return respond(context, employeeFormsRoutes.submitScreening, {
    status: result.reportStatus,
  });
});

employeeForms.post("/:id/checkr/refresh", requireManager(), async (context) => {
  const row = await findRequirement(context);
  if (!row?.checkr_report_id) {
    return context.json({ error: "Screening not submitted." }, 404);
  }
  const refreshed = await refreshCheckrScreening(context.env, {
    ...row,
    checkr_report_id: row.checkr_report_id,
    organization_id: context.get("organizationId"),
  });
  if (!refreshed) {
    return context.json({ error: "Screening changed. Please refresh." }, 409);
  }
  return respond(context, employeeFormsRoutes.refreshScreening, {
    reportStatus: refreshed.reportStatus,
    result: refreshed.result,
  });
});

// The signed authorization behind the ordered report, for the person and
// managers.
employeeForms.get("/:id/checkr/consent", async (context) => {
  const row = await findRequirement(context);
  if (!row?.checkr_consent_id || !(await canAccessRequirement(context, row))) {
    return context.json({ error: "Authorization not found." }, 404);
  }
  const consent = await context.env.DB.prepare(
    `SELECT document_key FROM employee_screening_consents
     WHERE id = ? AND organization_id = ? AND requirement_id = ?`,
  )
    .bind(row.checkr_consent_id, context.get("organizationId"), row.id)
    .first<{ document_key: string }>();
  const download =
    consent &&
    (await storedDownload(context.env.STORAGE, consent.document_key, {
      fallbackFilename: "background-check-authorization.pdf",
      headers: {
        "cache-control": "private, no-store",
        "content-type": "application/pdf",
      },
    }));
  return download || context.json({ error: "Authorization not found." }, 404);
});

employeeForms.onError((error, context) => {
  if (error instanceof CheckrRequestError) {
    console.error(error);
    return context.json({ error: error.message }, 502);
  }
  return respondToUnexpectedError(error, context);
});

interface ScreeningSubjectRow {
  checkr_report_id: string | null;
  checkr_requested_at: string | null;
  checkr_work_city: string | null;
  checkr_work_state: string | null;
  email: string;
  id: string;
  kind: string;
  name: string;
  organization_name: string;
  status: string;
  title: string;
  user_id: string;
}

/** The requirement when it belongs to the signed-in person, not a manager. */
async function findScreeningSubject(context: Context<ApiEnv>) {
  return context.env.DB.prepare(
    `SELECT requirement.id, requirement.kind, requirement.title,
            requirement.status, requirement.checkr_report_id,
            requirement.checkr_requested_at, requirement.checkr_work_state,
            requirement.checkr_work_city, target.id AS user_id, target.email,
            target.name, organization.name AS organization_name
     FROM employee_requirements AS requirement
     JOIN member ON member.id = requirement.member_id
       AND member.organizationId = requirement.organization_id
     JOIN user AS target ON target.id = member.userId
     JOIN organization ON organization.id = requirement.organization_id
     WHERE requirement.id = ? AND requirement.organization_id = ?
       AND member.userId = ?`,
  )
    .bind(
      context.req.param("id"),
      context.get("organizationId"),
      context.get("authSession").user.id,
    )
    .first<ScreeningSubjectRow>();
}

// A request sets the work state together with checkr_requested_at.
function awaitingSubmission(
  subject: ScreeningSubjectRow,
): subject is ScreeningSubjectRow & {
  checkr_requested_at: string;
  checkr_work_state: string;
} {
  return (
    subject.kind === "background_check" &&
    Boolean(subject.checkr_requested_at) &&
    !subject.checkr_report_id &&
    subject.status !== "complete"
  );
}

async function emailScreeningRequest(
  context: Context<ApiEnv>,
  row: RequirementRow,
) {
  const organization = await context.env.DB.prepare(
    "SELECT name FROM organization WHERE id = ?",
  )
    .bind(context.get("organizationId"))
    .first<{ name: string }>();
  if (!row.target_email) return;
  await sendScreeningRequest(context.env, {
    dueDate: row.due_date,
    memberId: row.member_id,
    organizationId: context.get("organizationId"),
    organizationName: organization?.name ?? "Your organization",
    recipient: {
      email: row.target_email,
      name: row.target_name ?? row.target_email.split("@")[0] ?? "there",
    },
    requirementId: row.id,
    title: row.title,
  });
}

export async function assignAcceptedInvitationRequirements(
  database: D1Database,
  organizationId: string,
  invitationId: string,
  memberId: string,
) {
  const statement = database.prepare(
    `UPDATE employee_requirements
     SET invitation_id = NULL, member_id = ?,
         assigned_user_id = (SELECT userId FROM member WHERE id = ?),
         updated_at = ?
     WHERE organization_id = ? AND invitation_id = ?`,
  );
  const values = [
    memberId,
    memberId,
    new Date().toISOString(),
    organizationId,
    invitationId,
  ];
  await statement.bind(...values).run();
}

export async function assignRenewedInvitationRequirements(
  database: D1Database,
  organizationId: string,
  invitationId: string,
  email: string,
) {
  const statement = database.prepare(
    `UPDATE employee_requirements
     SET invitation_id = ?, updated_at = ?
     WHERE organization_id = ? AND member_id IS NULL
       AND assigned_user_id IS NULL
       AND target_email = ? COLLATE NOCASE
       AND (invitation_id IS NULL OR EXISTS (
         SELECT 1 FROM invitation AS old
         WHERE old.id = employee_requirements.invitation_id
           AND (old.status <> 'pending' OR old.expiresAt <= ?)
       ))`,
  );
  const values = [
    invitationId,
    new Date().toISOString(),
    organizationId,
    email,
    new Date().toISOString(),
  ];
  await statement.bind(...values).run();
}

function toRequirement(
  row: RequirementRow,
  manager: boolean,
  env: Bindings,
): EmployeeRequirement {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    dueDate: row.due_date,
    status: row.status,
    hasDocument: Boolean(row.document_key),
    documentFilename: row.document_filename,
    documentSize: row.document_size,
    documentRevision: row.document_revision,
    invitationId: row.invitation_id,
    invitationStatus: row.invitation_status,
    memberId: row.member_id,
    targetEmail: row.target_email,
    targetName: row.target_name,
    completedAt: row.completed_at,
    checkrAvailable:
      Boolean(row.member_id || row.invitation_status === "pending") &&
      checkrConfigured(env, row.kind),
    // Requested and waiting for the person to submit their details.
    checkrRequested: awaitingDetails(row),
    canSubmitCheckr:
      Boolean(row.is_subject) &&
      awaitingDetails(row) &&
      checkrConfigured(env, row.kind),
    checkrSubmitting: Boolean(row.checkr_start_nonce),
    checkrWorkLocation: row.checkr_work_state
      ? { city: row.checkr_work_city, state: row.checkr_work_state }
      : null,
    checkrReportStatus: row.checkr_report_id ? row.checkr_report_status : null,
    checkrResult: manager ? row.checkr_result : null,
    hasCheckrConsent: Boolean(row.checkr_consent_id),
  };
}

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

function awaitingDetails(row: RequirementRow) {
  return (
    Boolean(row.checkr_requested_at) &&
    !row.checkr_report_id &&
    row.status !== "complete"
  );
}

/** Submitted to Checkr, or being submitted, and not canceled. */
function screeningActive(row: RequirementRow) {
  return (
    row.checkr_starting_at !== null ||
    row.checkr_start_nonce !== null ||
    (row.checkr_report_id !== null &&
      !isClosedReportStatus(row.checkr_report_status))
  );
}

async function findRequirement(context: Context<ApiEnv>) {
  return context.env.DB.prepare(
    `SELECT requirement.id, requirement.kind, requirement.title,
            requirement.due_date, requirement.status, requirement.document_key,
            document_filename, document_size, document_revision,
            invitation_id,
            invitation.status AS invitation_status, member_id,
            completed_at, checkr_report_id, checkr_report_status,
            checkr_result, checkr_consent_id, checkr_requested_at,
            checkr_work_state, checkr_work_city, checkr_starting_at,
            checkr_start_nonce, checkr_refresh_revision,
            COALESCE(target.email, invitation.email, requirement.target_email)
              AS target_email,
            target.name AS target_name
     FROM employee_requirements AS requirement
     LEFT JOIN member ON member.id = requirement.member_id
     LEFT JOIN user AS target ON target.id = member.userId
     LEFT JOIN invitation ON invitation.id = requirement.invitation_id
     WHERE requirement.id = ? AND requirement.organization_id = ?`,
  )
    .bind(context.req.param("id"), context.get("organizationId"))
    .first<RequirementRow>();
}

async function canAccessRequirement(
  context: Context<ApiEnv>,
  row: RequirementRow,
) {
  if (canManage(context)) return true;
  if (!row.member_id) return false;
  const member = await context.env.DB.prepare(
    `SELECT id FROM member WHERE id = ? AND organizationId = ? AND userId = ?`,
  )
    .bind(
      row.member_id,
      context.get("organizationId"),
      context.get("authSession").user.id,
    )
    .first<{ id: string }>();
  return Boolean(member);
}

function signedInAsSelf(context: Context<ApiEnv>) {
  return (
    !context.get("apiKey") &&
    !context.get("authSession").session?.impersonatedBy
  );
}

function signInRequired(context: Context<ApiEnv>) {
  return context.json(
    { error: "Sign in to complete your own background check." },
    403,
  );
}

export { employeeForms };
