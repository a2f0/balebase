import {
  employeeFormsRoutes,
  screeningMessages,
} from "@balebase/validators/employeeForms";
import { type Context, Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { requireManager } from "../organizations/organizationMembers";
import { readBody, respond } from "../shared/respond";
import { storedDownload } from "../shared/storage";
import {
  checkrConfigured,
  checkrPackage,
  checkrPackageScreenings,
  checkrTestMode,
} from "./checkr";
import {
  refreshCheckrScreening,
  requestCheckrScreening,
  submitCheckrScreening,
} from "./checkrScreening";
import { checkrTestCandidates } from "./checkrTestCandidates";
import {
  canAccessRequirement,
  findRequirement,
  type RequirementRow,
  screeningActive,
} from "./employeeFormRecords";
import {
  disclosureFingerprint,
  screeningDisclosures,
  summaryOfRightsUrl,
} from "./screeningDisclosures";
import { sendScreeningRequest } from "./screeningMail";
import { parseScreeningSubmission } from "./screeningSubmission";

/** Requesting, submitting, refreshing, and reading Checkr screenings. */
export const employeeFormScreening = new Hono<ApiEnv>();

employeeFormScreening.post(
  "/:id/checkr/request",
  requireManager(),
  async (context) => {
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
  },
);

// The person's own screening form: the disclosures to read, the work
// location, and, while Checkr is in staging, its mocked test candidates.
employeeFormScreening.get("/:id/checkr/form", async (context) => {
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

employeeFormScreening.post("/:id/checkr/submit", async (context) => {
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

employeeFormScreening.post(
  "/:id/checkr/refresh",
  requireManager(),
  async (context) => {
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
  },
);

// The signed authorization behind the ordered report, for the person and
// managers.
employeeFormScreening.get("/:id/checkr/consent", async (context) => {
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
