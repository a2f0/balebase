import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
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
import { normalizeFilename } from "./filenames";
import { canManageOrganization } from "./organizationMembers";
import {
  disclosureFingerprint,
  screeningDisclosures,
  summaryOfRightsUrl,
} from "./screeningDisclosures";
import { sendScreeningRequest } from "./screeningMail";
import { isUsStateCode, parseScreeningSubmission } from "./screeningSubmission";
import type { Bindings } from "./types";

type RequirementKind = "form" | "background_check" | "credit_check";
type RequirementStatus = "pending" | "in_progress" | "submitted" | "complete";
interface RequirementInput {
  dueDate: string;
  kind: RequirementKind;
  title: string;
}
interface RequirementRow {
  id: string;
  kind: RequirementKind;
  title: string;
  due_date: string;
  status: RequirementStatus;
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

type EmployeeFormsEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};
const employeeForms = new Hono<EmployeeFormsEnv>();
const maxDocumentBytes = 10 * 1024 * 1024;
const maxMultipartBytes = maxDocumentBytes + 256 * 1024;
const documentTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);

employeeForms.get("/", async (context) => {
  const organizationId = context.get("organizationId");
  const manager = canManageOrganization(context.get("organizationRole"));
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
  return context.json({
    requirements: result.results.map((row) =>
      toRequirement(row, manager, context.env),
    ),
  });
});

employeeForms.post("/", async (context) => {
  if (!canManageOrganization(context.get("organizationRole"))) {
    return managerRequired(context);
  }
  const body: unknown = await context.req.json().catch(() => null);
  if (!isRecord(body)) {
    return context.json(
      { error: "A target and requirements are required." },
      400,
    );
  }
  const memberId = typeof body.memberId === "string" ? body.memberId : null;
  const invitationId =
    typeof body.invitationId === "string" ? body.invitationId : null;
  if (Boolean(memberId) === Boolean(invitationId)) {
    return context.json({ error: "Choose one member or invitation." }, 400);
  }
  if (
    !Array.isArray(body.requirements) ||
    body.requirements.length < 1 ||
    body.requirements.length > 20 ||
    !body.requirements.every(isRequirementInput)
  ) {
    return context.json({ error: "Choose 1 to 20 valid requirements." }, 400);
  }
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
  const requirements = body.requirements as RequirementInput[];
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
        requirement.title.trim(),
        requirement.dueDate,
        now,
        now,
        memberId ?? invitationId,
        organizationId,
      ),
    ),
  );
  if (inserted.some((result) => result.meta.changes !== 1)) {
    return context.json(
      { error: "The invitation or membership changed. Please try again." },
      409,
    );
  }
  return context.json({ ids }, 201);
});

employeeForms.patch("/:id", async (context) => {
  if (!canManageOrganization(context.get("organizationRole"))) {
    return managerRequired(context);
  }
  const row = await findRequirement(context);
  if (!row) return context.json({ error: "Requirement not found." }, 404);
  const body: unknown = await context.req.json().catch(() => null);
  if (!isRecord(body)) return context.json({ error: "Invalid update." }, 400);
  const status = body.status;
  const dueDate = body.dueDate;
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
  return context.json({ ok: true });
});

employeeForms.delete("/:id", async (context) => {
  if (!canManageOrganization(context.get("organizationRole"))) {
    return managerRequired(context);
  }
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
  return context.json({ ok: true });
});

employeeForms.post("/:id/document", async (context) => {
  const row = await findRequirement(context);
  if (!row || !(await canAccessRequirement(context, row))) {
    return context.json({ error: "Requirement not found." }, 404);
  }
  if (row.kind !== "form") {
    return context.json({ error: "Only forms accept documents." }, 400);
  }
  const file = await readBoundedDocumentFile(context.req.raw);
  if (file === "too_large") {
    return context.json({ error: "Files must be 10 MB or smaller." }, 413);
  }
  if (!(file instanceof File) || !documentTypes.has(file.type)) {
    return context.json({ error: "Choose a PDF, JPEG, or PNG file." }, 400);
  }
  if (!file.size || file.size > maxDocumentBytes) {
    return context.json({ error: "Files must be 10 MB or smaller." }, 413);
  }
  const key = `organizations/${context.get("organizationId")}/employee-forms/${row.id}/${crypto.randomUUID()}`;
  const filename = normalizeFilename(file.name, "form", 200);
  await context.env.DB.prepare(
    `INSERT INTO deleted_object_cleanup
       (id, organization_id, object_key, deleted_at, cleanup_token,
        cleanup_claimed_at)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
  )
    .bind(
      `employee-form-upload:${crypto.randomUUID()}`,
      context.get("organizationId"),
      key,
      new Date().toISOString(),
    )
    .run();
  try {
    await context.env.STORAGE.put(key, file, {
      httpMetadata: { contentType: file.type },
    });
    const updated = await context.env.DB.prepare(
      `UPDATE employee_requirements
       SET document_key = ?, document_filename = ?, document_size = ?,
           document_revision = document_revision + 1,
           status = 'submitted', completed_at = NULL, updated_at = ?
       WHERE id = ? AND organization_id = ? AND document_key IS ?
         AND EXISTS (
           SELECT 1 FROM deleted_object_cleanup
           WHERE object_key = ? AND cleanup_token IS NULL
         )
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
        canManageOrganization(context.get("organizationRole")) ? 1 : 0,
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
      return context.json({ filename, status: "submitted" });
    }
    await context.env.STORAGE.delete(key).catch(console.error);
    throw cause;
  }
  return context.json({ filename, status: "submitted" });
});

async function readBoundedDocumentFile(request: Request) {
  const contentType = request.headers.get("content-type");
  if (!contentType?.startsWith("multipart/form-data") || !request.body) {
    return null;
  }
  const advertisedLength = Number(request.headers.get("content-length"));
  if (advertisedLength > maxMultipartBytes) return "too_large";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxMultipartBytes) {
        await reader.cancel();
        return "too_large";
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const parsed = await new Response(new Blob(chunks), {
    headers: { "Content-Type": contentType },
  })
    .formData()
    .catch(() => null);
  const file = parsed?.get("file");
  return file instanceof File ? file : null;
}

employeeForms.get("/:id/document", async (context) => {
  const row = await findRequirement(context);
  if (
    !row ||
    !(await canAccessRequirement(context, row)) ||
    !row.document_key
  ) {
    return context.json({ error: "Document not found." }, 404);
  }
  const object = await context.env.STORAGE.get(row.document_key);
  if (!object) return context.json({ error: "Document not found." }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Document-Revision", String(row.document_revision));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set(
    "Content-Disposition",
    `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(row.document_filename ?? "document")}`,
  );
  return new Response(object.body, { headers });
});

employeeForms.post("/:id/checkr/request", async (context) => {
  if (!canManageOrganization(context.get("organizationRole"))) {
    return managerRequired(context);
  }
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
  const body: unknown = await context.req.json().catch(() => null);
  if (!isRecord(body) || !isUsStateCode(body.state) || !isCity(body.city)) {
    return context.json(
      { error: "A US work state and optional city are required." },
      400,
    );
  }
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
    body.city?.trim() || null,
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
  return context.json({ emailed });
});

// The person's own screening form: the disclosures to read, the work
// location, and, while Checkr is in staging, its mocked test candidates.
employeeForms.get("/:id/checkr/form", async (context) => {
  if (context.get("apiKey")) return signInRequired(context);
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
  return context.json({
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
  // An API key acts as its creator; only the person may sign for themselves.
  if (context.get("apiKey")) return signInRequired(context);
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
  const body: unknown = await context.req.json().catch(() => null);
  // The person authorizes the request their form showed, not a newer one.
  if (
    !isRecord(body) ||
    (body as { requestRevision?: unknown }).requestRevision !==
      subject.checkr_requested_at
  ) {
    return context.json(
      {
        error:
          "This background check changed after you opened it. Reload the page to review it again.",
      },
      409,
    );
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
  return context.json({ status: result.reportStatus });
});

employeeForms.post("/:id/checkr/refresh", async (context) => {
  if (!canManageOrganization(context.get("organizationRole"))) {
    return managerRequired(context);
  }
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
  return context.json(refreshed);
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
  const object = consent
    ? await context.env.STORAGE.get(consent.document_key)
    : null;
  if (!object) return context.json({ error: "Authorization not found." }, 404);
  return new Response(object.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition":
        'attachment; filename="background-check-authorization.pdf"',
      "Content-Type": "application/pdf",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

employeeForms.onError((error, context) => {
  console.error(error);
  if (error instanceof CheckrRequestError) {
    return context.json({ error: error.message }, 502);
  }
  return context.json({ error: "Unexpected server error." }, 500);
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
async function findScreeningSubject(context: Context<EmployeeFormsEnv>) {
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

function awaitingSubmission(subject: ScreeningSubjectRow) {
  return (
    subject.kind === "background_check" &&
    Boolean(subject.checkr_requested_at) &&
    !subject.checkr_report_id &&
    subject.status !== "complete"
  );
}

async function emailScreeningRequest(
  context: Context<EmployeeFormsEnv>,
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
  if (typeof statement.bind === "function") {
    await statement.bind(...values).run();
  } else {
    await (
      statement as unknown as { run: (...values: string[]) => unknown }
    ).run(...values);
  }
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
  if (typeof statement.bind === "function") {
    await statement.bind(...values).run();
  } else {
    await (
      statement as unknown as { run: (...values: string[]) => unknown }
    ).run(...values);
  }
}

function toRequirement(row: RequirementRow, manager: boolean, env: Bindings) {
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

interface InputRecord {
  memberId?: unknown;
  invitationId?: unknown;
  requirements?: unknown;
  status?: unknown;
  dueDate?: unknown;
  file?: unknown;
  documentRevision?: unknown;
  kind?: unknown;
  title?: unknown;
  state?: unknown;
  city?: unknown;
}

function isRecord(value: unknown): value is InputRecord {
  return typeof value === "object" && value !== null;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function isRequirementInput(value: unknown): value is RequirementInput {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    ["form", "background_check", "credit_check"].includes(value.kind) &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    value.title.trim().length <= 100 &&
    isDate(value.dueDate)
  );
}

function isStatus(value: unknown): value is RequirementStatus {
  return (
    typeof value === "string" &&
    ["pending", "in_progress", "submitted", "complete"].includes(value)
  );
}

function isValidRequirementUpdate(row: RequirementRow, body: InputRecord) {
  const { status, dueDate, documentRevision } = body;
  return !(
    (status !== undefined && !isStatus(status)) ||
    (dueDate !== undefined && !isDate(dueDate)) ||
    (documentRevision !== undefined &&
      (!Number.isSafeInteger(documentRevision) ||
        Number(documentRevision) < 0)) ||
    (status === undefined && dueDate === undefined) ||
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

function isCity(value: unknown): value is string | undefined {
  return (
    value === undefined || (typeof value === "string" && value.length <= 100)
  );
}

async function findRequirement(context: Context<EmployeeFormsEnv>) {
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
  context: Context<EmployeeFormsEnv>,
  row: RequirementRow,
) {
  if (canManageOrganization(context.get("organizationRole"))) return true;
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

function signInRequired(context: Context<EmployeeFormsEnv>) {
  return context.json(
    { error: "Sign in to complete your own background check." },
    403,
  );
}

function managerRequired(context: Context<EmployeeFormsEnv>) {
  return context.json({ error: "Organization manager access required." }, 403);
}

export { employeeForms };
