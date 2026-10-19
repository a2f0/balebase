import {
  type CheckrCandidate,
  CheckrRequestError,
  createCheckrCandidate,
  createCheckrReport,
  getCheckrCandidate,
  getCheckrReport,
  isDefinitiveCheckrRejection,
  uploadCheckrConsent,
} from "./checkr";
import { buildScreeningConsentPdf } from "./screeningConsentPdf";
import { screeningDisclosures } from "./screeningDisclosures";
import type { ScreeningSubmission } from "./screeningSubmission";
import type { Bindings } from "./types";

// A canceled report frees the screening to be requested again.
export function isClosedReportStatus(status: string | null) {
  return status === "canceled" || status === "partially_canceled";
}

export interface CheckrScreeningRow {
  id: string;
  organization_id: string;
  status: string;
  checkr_report_id: string;
  checkr_report_status: string | null;
  checkr_refresh_revision: number;
}

// Records the current Checkr report state on an ordered screening, and clears
// any refresh requested before this one began. Returns null when another
// refresh or edit changed it first. Every attempt records checkr_checked_at,
// so a screening Checkr keeps failing on cannot hold its place at the front
// of the scheduled refresh.
export async function refreshCheckrScreening(
  env: Bindings,
  row: CheckrScreeningRow,
) {
  const checkedAt = new Date().toISOString();
  const report = await getCheckrReport(env, row.checkr_report_id).catch(
    async (cause: unknown) => {
      await env.DB.prepare(
        `UPDATE employee_requirements SET checkr_checked_at = ?
         WHERE id = ? AND organization_id = ?`,
      )
        .bind(checkedAt, row.id, row.organization_id)
        .run();
      throw cause;
    },
  );
  const reportStatus =
    report.status === "complete" && report.includes_canceled
      ? report.result
        ? "partially_canceled"
        : "canceled"
      : report.status;
  // A manager may complete a canceled screening by hand; keep that.
  const complete =
    (report.status === "complete" && !report.includes_canceled) ||
    (row.status === "complete" &&
      isClosedReportStatus(row.checkr_report_status));
  const nextStatus = complete
    ? "complete"
    : isClosedReportStatus(reportStatus)
      ? "pending"
      : "in_progress";
  const now = new Date().toISOString();
  const refreshed = await env.DB.prepare(
    `UPDATE employee_requirements
     SET checkr_report_status = ?, checkr_result = ?, status = ?,
         completed_at = CASE WHEN ? = 'complete'
           THEN COALESCE(completed_at, ?) ELSE NULL END,
         updated_at = ?, checkr_checked_at = ?,
         checkr_refresh_requested_at = CASE
           WHEN checkr_refresh_requested_at <= ? THEN NULL
           ELSE checkr_refresh_requested_at
         END,
         checkr_refresh_revision = checkr_refresh_revision + 1
     WHERE id = ? AND organization_id = ? AND checkr_report_id = ?
       AND checkr_refresh_revision = ?`,
  )
    .bind(
      reportStatus,
      report.result ?? null,
      nextStatus,
      nextStatus,
      now,
      now,
      checkedAt,
      checkedAt,
      row.id,
      row.organization_id,
      row.checkr_report_id,
      row.checkr_refresh_revision,
    )
    .run();
  if (!refreshed.meta.changes) return null;
  return { reportStatus, result: report.result ?? null };
}

/** Asks the person to complete a background check at a work location. */
export async function requestCheckrScreening(
  database: D1Database,
  organizationId: string,
  requirementId: string,
  state: string,
  city: string | null,
) {
  const now = new Date().toISOString();
  const updated = await database
    .prepare(
      `UPDATE employee_requirements
       SET checkr_work_state = ?, checkr_work_city = ?,
           checkr_requested_at = ?, checkr_report_id = NULL,
           checkr_report_status = NULL, checkr_result = NULL,
           checkr_consent_id = NULL, checkr_candidate_id = NULL,
           checkr_start_package = NULL, checkr_refresh_requested_at = NULL,
           status = 'pending', completed_at = NULL,
           checkr_refresh_revision = checkr_refresh_revision + 1,
           updated_at = ?
       WHERE id = ? AND organization_id = ? AND kind = 'background_check'
         AND checkr_starting_at IS NULL AND checkr_start_nonce IS NULL
         AND (checkr_report_id IS NULL OR
              checkr_report_status IN ('canceled', 'partially_canceled'))`,
    )
    .bind(state, city, now, now, requirementId, organizationId)
    .run();
  return updated.meta.changes > 0;
}

export interface ScreeningSubject {
  email: string;
  organizationId: string;
  organizationName: string;
  packageSlug: string;
  requirementId: string;
  requirementTitle: string;
  userId: string;
  workCity: string | null;
  workState: string;
}

export type ScreeningSubmitResult =
  | { kind: "conflict"; message: string }
  | { kind: "rejected"; message: string }
  | { kind: "submitted"; reportStatus: string };

interface SubmitClaim {
  checkr_attempt_consent_id: string | null;
  checkr_candidate_id: string | null;
  checkr_report_requested_at: string | null;
  checkr_start_nonce: string;
  checkr_start_nonce_at: string;
  checkr_start_package: string;
}

/** How long a report request may take to reach Checkr after its response is lost. */
const reportSettleMs = 10 * 60_000;

/**
 * Orders the person's report: records their signed authorization, creates the
 * Checkr candidate with their details, attaches the authorization, and creates
 * the report. Each Checkr call carries an idempotency key from this attempt, so
 * a retry after a lost response replays it. A retry first asks Checkr about
 * the attempt's candidate: it adopts a report the candidate already has, with
 * the authorization that ordered it; continues with the candidate when the
 * details match; and otherwise starts a new candidate once no report request
 * can still be on its way. When Checkr rejects the details, the attempt is
 * cleared so the person can correct them and submit again.
 */
export async function submitCheckrScreening(
  env: Bindings,
  subject: ScreeningSubject,
  submission: ScreeningSubmission,
  signer: { ipAddress: string | null; userAgent: string | null },
): Promise<ScreeningSubmitResult> {
  const claim = await claimSubmission(env.DB, subject);
  if (!claim)
    return conflict(
      "This background check is changing. Refresh and try again.",
    );
  let nonce = claim.checkr_start_nonce;
  try {
    let candidateId = claim.checkr_candidate_id;
    if (candidateId) {
      const resumed = await resumeAttempt(env, subject, submission, claim);
      if (resumed.kind === "adopt") {
        return await storeReport(
          env.DB,
          subject,
          nonce,
          candidateId,
          claim.checkr_attempt_consent_id,
          resumed.report,
        );
      }
      if (resumed.kind === "wait") {
        await releaseSubmission(env.DB, subject, nonce, false);
        return conflict(
          "Your earlier submission may still be reaching Checkr. Wait a few minutes, then submit again.",
        );
      }
      if (resumed.kind === "restart") {
        nonce = resumed.nonce;
        candidateId = null;
      }
    }
    nonce = await freshNonce(env.DB, subject, claim, nonce);
    const consent = await recordConsent(env, subject, submission, signer);
    candidateId ??= await createCandidate(env, subject, submission, nonce);
    if (!candidateId)
      return conflict("This background check changed. Refresh and try again.");
    const report = await orderReport(
      env,
      subject,
      claim,
      candidateId,
      consent,
      nonce,
    );
    return await storeReport(
      env.DB,
      subject,
      nonce,
      candidateId,
      consent.id,
      report,
    );
  } catch (cause) {
    const rejected = isDefinitiveCheckrRejection(cause);
    await releaseSubmission(env.DB, subject, nonce, rejected);
    if (rejected && cause instanceof CheckrRequestError) {
      return {
        kind: "rejected",
        message: `Checkr couldn't accept these details: ${cause.detail}`,
      };
    }
    throw cause;
  }
}

function conflict(message: string): ScreeningSubmitResult {
  return { kind: "conflict", message };
}

type Resumed =
  | { kind: "adopt"; report: StoredReport }
  | { kind: "restart"; nonce: string }
  | { kind: "reuse" }
  | { kind: "wait" };

interface StoredReport {
  id: string;
  result: string | null;
  status: string;
}

async function resumeAttempt(
  env: Bindings,
  subject: ScreeningSubject,
  submission: ScreeningSubmission,
  claim: SubmitClaim,
): Promise<Resumed> {
  const candidate = await getCheckrCandidate(
    env,
    claim.checkr_candidate_id ?? "",
  );
  const reportId = candidate.report_ids?.at(-1);
  if (reportId) {
    const report = await getCheckrReport(env, reportId);
    return {
      kind: "adopt",
      report: {
        id: report.id,
        result: report.result ?? null,
        status: report.status,
      },
    };
  }
  if (sameDetails(candidate, subject.email, submission))
    return { kind: "reuse" };
  const requestedAt = Date.parse(claim.checkr_report_requested_at ?? "");
  if (
    Number.isFinite(requestedAt) &&
    requestedAt > Date.now() - reportSettleMs
  ) {
    return { kind: "wait" };
  }
  return {
    kind: "restart",
    nonce: await restartAttempt(env.DB, subject, claim),
  };
}

/**
 * Whether the person submitted what Checkr holds for the candidate. Fields
 * Checkr leaves out or redacts count as matching; the SSN's last four digits
 * stand in for the rest.
 */
function sameDetails(
  candidate: CheckrCandidate,
  email: string,
  { candidate: details, copyRequested }: ScreeningSubmission,
) {
  const same = (
    stored: string | null | undefined,
    value: string | null,
    normalize = (text: string) => text.trim().toLowerCase(),
  ) =>
    stored === undefined || normalize(stored ?? "") === normalize(value ?? "");
  const digits = (text: string) =>
    text.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const license = candidate.driver_license_number;
  return (
    same(candidate.first_name, details.firstName) &&
    same(candidate.middle_name, details.middleName) &&
    same(candidate.last_name, details.lastName) &&
    same(candidate.dob, details.dob) &&
    same(candidate.zipcode, details.zipcode) &&
    same(candidate.email, email) &&
    same(candidate.phone, details.phone, digits) &&
    same(candidate.driver_license_state, details.driverLicenseState) &&
    (/x/i.test(license ?? "") || same(license, details.driverLicenseNumber)) &&
    (typeof candidate.ssn !== "string" ||
      candidate.ssn.slice(-4) === details.ssn.slice(-4)) &&
    (candidate.copy_requested === undefined ||
      candidate.copy_requested === copyRequested)
  );
}

async function createCandidate(
  env: Bindings,
  subject: ScreeningSubject,
  submission: ScreeningSubmission,
  nonce: string,
) {
  const created = await createCheckrCandidate(
    env,
    { ...submission.candidate, email: subject.email },
    subject.requirementId,
    submission.copyRequested,
    `${nonce}:candidate`,
  );
  if (!created.id) throw new Error("Checkr did not return a candidate ID.");
  const stored = await env.DB.prepare(
    `UPDATE employee_requirements
     SET checkr_candidate_id = ?, updated_at = ?
     WHERE id = ? AND organization_id = ? AND checkr_start_nonce = ?`,
  )
    .bind(
      created.id,
      new Date().toISOString(),
      subject.requirementId,
      subject.organizationId,
      nonce,
    )
    .run();
  return stored.meta.changes ? created.id : null;
}

async function orderReport(
  env: Bindings,
  subject: ScreeningSubject,
  claim: SubmitClaim,
  candidateId: string,
  consent: { id: string; pdf: Uint8Array },
  nonce: string,
): Promise<StoredReport> {
  await uploadCheckrConsent(
    env,
    candidateId,
    consent.pdf,
    "background-check-authorization.pdf",
    `${nonce}:consent:${consent.id}`,
  );
  // Recorded before asking, so a retry adopts any report with this consent
  // and waits for a request whose response was lost.
  const marked = await env.DB.prepare(
    `UPDATE employee_requirements
     SET checkr_attempt_consent_id = ?, checkr_report_requested_at = ?
     WHERE id = ? AND organization_id = ? AND checkr_start_nonce = ?`,
  )
    .bind(
      consent.id,
      new Date().toISOString(),
      subject.requirementId,
      subject.organizationId,
      nonce,
    )
    .run();
  if (!marked.meta.changes) throw new Error("The screening attempt changed.");
  const report = await createCheckrReport(
    env,
    candidateId,
    claim.checkr_start_package,
    subject.workState,
    subject.workCity ?? "",
    `${nonce}:report`,
  );
  if (!report.id) throw new Error("Checkr did not return a report ID.");
  return {
    id: report.id,
    result: report.result ?? null,
    status: report.status,
  };
}

// Holds the screening for one submission at a time. An attempt keeps its
// nonce, package, and candidate until it succeeds or Checkr rejects it, so a
// retry after a lost response reuses its idempotency keys.
async function claimSubmission(
  database: D1Database,
  subject: ScreeningSubject,
) {
  const now = new Date();
  return database
    .prepare(
      `UPDATE employee_requirements
       SET checkr_start_nonce = COALESCE(checkr_start_nonce, ?),
           checkr_start_nonce_at = COALESCE(checkr_start_nonce_at, ?),
           checkr_start_package = COALESCE(checkr_start_package, ?),
           checkr_starting_at = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND kind = 'background_check'
         AND checkr_requested_at IS NOT NULL AND checkr_report_id IS NULL
         AND status <> 'complete'
         AND (checkr_starting_at IS NULL OR checkr_starting_at < ?)
       RETURNING checkr_attempt_consent_id, checkr_candidate_id,
                 checkr_report_requested_at, checkr_start_nonce,
                 checkr_start_nonce_at, checkr_start_package`,
    )
    .bind(
      crypto.randomUUID(),
      now.toISOString(),
      subject.packageSlug,
      now.toISOString(),
      now.toISOString(),
      subject.requirementId,
      subject.organizationId,
      new Date(now.getTime() - 5 * 60_000).toISOString(),
    )
    .first<SubmitClaim>();
}

// Replaces an attempt whose candidate holds other details and never got a
// report, so corrected details go to a new candidate under new keys.
async function restartAttempt(
  database: D1Database,
  subject: ScreeningSubject,
  claim: SubmitClaim,
) {
  const next = crypto.randomUUID();
  const now = new Date().toISOString();
  const restarted = await database
    .prepare(
      `UPDATE employee_requirements
       SET checkr_start_nonce = ?, checkr_start_nonce_at = ?,
           checkr_candidate_id = NULL, checkr_attempt_consent_id = NULL,
           checkr_report_requested_at = NULL, updated_at = ?
       WHERE id = ? AND organization_id = ? AND checkr_start_nonce = ?`,
    )
    .bind(
      next,
      now,
      now,
      subject.requirementId,
      subject.organizationId,
      claim.checkr_start_nonce,
    )
    .run();
  if (!restarted.meta.changes)
    throw new Error("The screening attempt changed.");
  claim.checkr_start_nonce_at = now;
  return next;
}

// Checkr keeps idempotency keys for a day, so an older attempt continues
// under a new nonce; its stored candidate still prevents a second report.
async function freshNonce(
  database: D1Database,
  subject: ScreeningSubject,
  claim: SubmitClaim,
  nonce: string,
) {
  if (
    new Date(claim.checkr_start_nonce_at).getTime() >=
    Date.now() - 23 * 60 * 60_000
  ) {
    return nonce;
  }
  const next = crypto.randomUUID();
  const rotated = await database
    .prepare(
      `UPDATE employee_requirements
       SET checkr_start_nonce = ?, checkr_start_nonce_at = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND checkr_start_nonce = ?`,
    )
    .bind(
      next,
      new Date().toISOString(),
      new Date().toISOString(),
      subject.requirementId,
      subject.organizationId,
      nonce,
    )
    .run();
  if (!rotated.meta.changes) throw new Error("The screening attempt changed.");
  return next;
}

/** Stores the signed authorization before anything is sent to Checkr. */
async function recordConsent(
  env: Bindings,
  subject: ScreeningSubject,
  submission: ScreeningSubmission,
  signer: { ipAddress: string | null; userAgent: string | null },
) {
  const id = crypto.randomUUID();
  const signedAt = new Date().toISOString();
  const disclosures = screeningDisclosures(subject.organizationName);
  const pdf = await buildScreeningConsentPdf(
    {
      consentId: id,
      copyRequested: submission.copyRequested,
      email: subject.email,
      ipAddress: signer.ipAddress,
      organizationName: subject.organizationName,
      requirementTitle: subject.requirementTitle,
      residenceState: submission.residenceState,
      signatureName: submission.signatureName,
      signedAt,
      stateNotices: submission.stateNotices,
      userAgent: signer.userAgent,
      workCity: subject.workCity,
      workState: subject.workState,
    },
    disclosures,
  );
  const key = `organizations/${subject.organizationId}/screening-consents/${subject.requirementId}/${id}.pdf`;
  await env.STORAGE.put(key, pdf, {
    httpMetadata: { contentType: "application/pdf" },
  });
  try {
    await env.DB.prepare(
      `INSERT INTO employee_screening_consents
       (id, organization_id, requirement_id, user_id, signature_name,
        signed_at, ip_address, user_agent, disclosure_version, state_notices,
        copy_requested, document_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        subject.organizationId,
        subject.requirementId,
        subject.userId,
        submission.signatureName,
        signedAt,
        signer.ipAddress,
        signer.userAgent?.slice(0, 500) ?? null,
        disclosures.version,
        JSON.stringify(submission.stateNotices),
        submission.copyRequested ? 1 : 0,
        key,
        signedAt,
      )
      .run();
  } catch (cause) {
    await env.STORAGE.delete(key).catch(() => undefined);
    throw cause;
  }
  return { id, pdf };
}

async function storeReport(
  database: D1Database,
  subject: ScreeningSubject,
  nonce: string,
  candidateId: string,
  consentId: string | null,
  report: StoredReport,
): Promise<ScreeningSubmitResult> {
  const stored = await database
    .prepare(
      `UPDATE employee_requirements
       SET checkr_candidate_id = ?, checkr_report_id = ?,
           checkr_report_status = ?, checkr_result = ?, checkr_consent_id = ?,
           status = 'in_progress', checkr_starting_at = NULL,
           checkr_start_nonce = NULL, checkr_start_nonce_at = NULL,
           checkr_attempt_consent_id = NULL,
           checkr_report_requested_at = NULL,
           checkr_refresh_requested_at = ?,
           checkr_refresh_revision = checkr_refresh_revision + 1,
           updated_at = ?
       WHERE id = ? AND organization_id = ? AND checkr_start_nonce = ?`,
    )
    .bind(
      candidateId,
      report.id,
      report.status,
      report.result,
      consentId,
      // An adopted report may already be finished; the next refresh settles it.
      report.status === "pending" ? null : new Date().toISOString(),
      new Date().toISOString(),
      subject.requirementId,
      subject.organizationId,
      nonce,
    )
    .run();
  if (!stored.meta.changes)
    return conflict("This background check changed. Refresh and try again.");
  return { kind: "submitted", reportStatus: report.status };
}

// Ends this attempt's hold on the screening. After a definitive rejection the
// attempt is cleared, including its candidate, so corrected details start a
// new candidate; otherwise a retry resumes it.
async function releaseSubmission(
  database: D1Database,
  subject: ScreeningSubject,
  nonce: string,
  clear: boolean,
) {
  await database
    .prepare(
      `UPDATE employee_requirements
       SET checkr_starting_at = NULL,
           checkr_start_nonce = CASE WHEN ?1 = 1 THEN NULL ELSE checkr_start_nonce END,
           checkr_start_nonce_at = CASE WHEN ?1 = 1 THEN NULL ELSE checkr_start_nonce_at END,
           checkr_start_package = CASE WHEN ?1 = 1 THEN NULL ELSE checkr_start_package END,
           checkr_candidate_id = CASE WHEN ?1 = 1 THEN NULL ELSE checkr_candidate_id END,
           checkr_attempt_consent_id = CASE WHEN ?1 = 1 THEN NULL ELSE checkr_attempt_consent_id END,
           checkr_report_requested_at = CASE WHEN ?1 = 1 THEN NULL ELSE checkr_report_requested_at END,
           updated_at = ?2
       WHERE id = ?3 AND organization_id = ?4 AND checkr_start_nonce = ?5`,
    )
    .bind(
      clear ? 1 : 0,
      new Date().toISOString(),
      subject.requirementId,
      subject.organizationId,
      nonce,
    )
    .run();
}
