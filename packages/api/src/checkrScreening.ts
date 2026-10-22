import {
  CheckrRequestError,
  createCheckrCandidate,
  createCheckrReport,
  getCheckrCandidate,
  getCheckrReport,
  uploadCheckrConsent,
} from "./checkr";
import { buildScreeningConsentPdf } from "./screeningConsentPdf";
import type { ScreeningDisclosures } from "./screeningDisclosures";
import { sendPendingScreeningNotifications } from "./screeningNotifications";
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
  await sendPendingScreeningNotifications(env, row.id);
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
  /** The wording the person's form showed, which their signature records. */
  disclosures: ScreeningDisclosures;
  email: string;
  organizationId: string;
  organizationName: string;
  packageSlug: string;
  /** The request the person's form answered; a newer request supersedes it. */
  requestedAt: string;
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
  checkr_attempt_digest: string | null;
  checkr_candidate_id: string | null;
  checkr_report_requested_at: string | null;
  checkr_start_lease: string;
  checkr_start_nonce: string;
  checkr_start_nonce_at: string;
  checkr_start_package: string;
}

/**
 * Fences an attempt's writes to the claim that holds it: the nonce names the
 * attempt and its idempotency keys, and the lease names this claim, so a
 * request whose claim expired cannot overwrite or release a newer one.
 */
interface AttemptFence {
  lease: string;
  nonce: string;
}

/** How long a report request may take to reach Checkr after its response is lost. */
export const reportSettleMs = 10 * 60_000;

/**
 * Orders the person's report: records their signed authorization, creates the
 * Checkr candidate with their details, attaches the authorization, and creates
 * the report. Each Checkr call carries an idempotency key from this attempt, so
 * a retry after a lost response replays it. A retry first asks Checkr about
 * the attempt's candidate: it adopts a report the candidate already has, with
 * the authorization that ordered it; continues with the candidate when the
 * person sent the same details; and otherwise starts a new candidate once no
 * report request can still be on its way. When Checkr rejects the details, the
 * attempt is cleared so the person can correct them and submit again.
 */
export async function submitCheckrScreening(
  env: Bindings,
  subject: ScreeningSubject,
  submission: ScreeningSubmission,
  signer: { ipAddress: string | null; userAgent: string | null },
): Promise<ScreeningSubmitResult> {
  const claim = await claimSubmission(env.DB, subject);
  if (!claim) {
    return conflict(
      "This background check is changing. Refresh and try again.",
    );
  }
  const fence = {
    lease: claim.checkr_start_lease,
    nonce: claim.checkr_start_nonce,
  };
  try {
    const digest = await attemptDigest(env, subject, submission);
    const plan = await planAttempt(env, subject, claim, fence, digest);
    if (plan.kind === "adopt") {
      return await storeReport(
        env.DB,
        subject,
        fence,
        plan.candidateId,
        claim.checkr_attempt_consent_id,
        plan.report,
      );
    }
    if (plan.kind === "wait") {
      await releaseSubmission(env.DB, subject, fence, false);
      return conflict(
        "Your earlier submission may still be reaching Checkr. Wait a few minutes, then submit again.",
      );
    }
    fence.nonce = plan.nonce;
    // The report was already requested with this attempt's authorization;
    // ask again under the same key rather than attaching a newer one.
    if (plan.kind === "replay") {
      const report = await requestReport(
        env,
        subject,
        claim,
        plan.candidateId,
        fence,
      );
      return await storeReport(
        env.DB,
        subject,
        fence,
        plan.candidateId,
        claim.checkr_attempt_consent_id,
        report,
      );
    }
    const consent = await recordConsent(env, subject, submission, signer);
    const candidateId =
      plan.candidateId ??
      (await createCandidate(env, subject, submission, fence, digest));
    if (!candidateId) {
      return conflict("This background check changed. Refresh and try again.");
    }
    await uploadConsent(env, subject, candidateId, consent, fence);
    const report = await requestReport(env, subject, claim, candidateId, fence);
    return await storeReport(
      env.DB,
      subject,
      fence,
      candidateId,
      consent.id,
      report,
    );
  } catch (cause) {
    const rejected = cause instanceof RejectedDetails;
    await releaseSubmission(env.DB, subject, fence, rejected);
    if (cause instanceof AttemptChanged) {
      return conflict("This background check changed. Refresh and try again.");
    }
    if (rejected) {
      return {
        kind: "rejected",
        message: `Checkr couldn't accept these details: ${cause.detail}`,
      };
    }
    throw cause;
  }
}

/** Another request moved the attempt on, or the person left the organization. */
class AttemptChanged extends Error {
  constructor() {
    super("The screening attempt changed.");
  }
}

/**
 * Checkr refused the person's details when creating the candidate or report.
 * Only this clears an attempt: an outage, a lookup failure, or a credentials
 * problem keeps it, so its keys still prevent a second report.
 */
class RejectedDetails extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

async function rejectingDetails<T>(request: () => Promise<T>) {
  try {
    return await request();
  } catch (cause) {
    if (
      cause instanceof CheckrRequestError &&
      (cause.status === 400 || cause.status === 422)
    ) {
      throw new RejectedDetails(cause.detail);
    }
    throw cause;
  }
}

function conflict(message: string): ScreeningSubmitResult {
  return { kind: "conflict", message };
}

type AttemptPlan =
  | { candidateId: string; kind: "adopt"; report: StoredReport }
  | { candidateId: string | null; kind: "continue"; nonce: string }
  | { candidateId: string; kind: "replay"; nonce: string }
  | { kind: "wait" };

interface StoredReport {
  id: string;
  result: string | null;
  status: string;
}

/** The scope an attempt's database writes are limited to. */
type AttemptScope = Pick<ScreeningSubject, "organizationId" | "requirementId">;

// Decides how a submission continues the attempt it claimed. A report the
// candidate already has is adopted. The same details continue the attempt, or
// replay its report request. Corrected details start a new attempt, waiting
// out a report request that may still reach Checkr; a candidate request that
// lost its response may already have created a candidate with the old details
// under this attempt's key.
async function planAttempt(
  env: Bindings,
  subject: ScreeningSubject,
  claim: SubmitClaim,
  fence: AttemptFence,
  digest: string,
): Promise<AttemptPlan> {
  const nonce = fence.nonce;
  const candidateId = claim.checkr_candidate_id;
  const sameDetails = claim.checkr_attempt_digest === digest;
  if (!candidateId) {
    return sameDetails || !claim.checkr_attempt_digest
      ? { candidateId: null, kind: "continue", nonce }
      : {
          candidateId: null,
          kind: "continue",
          nonce: await restartAttempt(env.DB, subject, fence),
        };
  }
  const report = await candidateReport(env, candidateId);
  if (report) return { candidateId, kind: "adopt", report };
  if (sameDetails) {
    return claim.checkr_report_requested_at && claim.checkr_attempt_consent_id
      ? { candidateId, kind: "replay", nonce }
      : { candidateId, kind: "continue", nonce };
  }
  if (reportMayArrive(claim.checkr_report_requested_at))
    return { kind: "wait" };
  return {
    candidateId: null,
    kind: "continue",
    nonce: await restartAttempt(env.DB, subject, fence),
  };
}

async function candidateReport(env: Bindings, candidateId: string) {
  const candidate = await getCheckrCandidate(env, candidateId);
  const reportId = candidate.report_ids?.at(-1);
  if (!reportId) return null;
  const report = await getCheckrReport(env, reportId);
  return {
    id: report.id,
    result: report.result ?? null,
    status: report.status,
  };
}

function reportMayArrive(requestedAt: string | null) {
  const at = Date.parse(requestedAt ?? "");
  return Number.isFinite(at) && at > Date.now() - reportSettleMs;
}

export interface CheckrAttemptRow {
  checkr_attempt_consent_id: string | null;
  checkr_candidate_id: string | null;
  checkr_report_requested_at: string | null;
  checkr_start_nonce: string;
  id: string;
  organization_id: string;
}

/**
 * Settles an attempt its person did not finish, without them: adopts a report
 * Checkr made for its candidate, with the authorization that ordered it, or
 * clears the attempt once no report request can still arrive, so the manager
 * can request the check again or remove it. Returns what happened.
 */
export async function recoverCheckrAttempt(
  env: Bindings,
  row: CheckrAttemptRow,
) {
  const scope = { organizationId: row.organization_id, requirementId: row.id };
  const now = new Date();
  // The claim returns the attempt as it is now; a retry may have moved it on
  // since the row was read.
  const lease = crypto.randomUUID();
  const attempt = await env.DB.prepare(
    `UPDATE employee_requirements
     SET checkr_starting_at = ?1, checkr_checked_at = ?1,
         checkr_start_lease = ?6
     WHERE id = ?2 AND organization_id = ?3 AND checkr_start_nonce = ?4
       AND checkr_report_id IS NULL
       AND (checkr_starting_at IS NULL OR checkr_starting_at < ?5)
     RETURNING checkr_attempt_consent_id, checkr_candidate_id,
               checkr_report_requested_at, checkr_start_nonce`,
  )
    .bind(
      now.toISOString(),
      row.id,
      row.organization_id,
      row.checkr_start_nonce,
      new Date(now.getTime() - 5 * 60_000).toISOString(),
      lease,
    )
    .first<
      Pick<
        CheckrAttemptRow,
        | "checkr_attempt_consent_id"
        | "checkr_candidate_id"
        | "checkr_report_requested_at"
        | "checkr_start_nonce"
      >
    >();
  if (!attempt) return "busy";
  const fence = { lease, nonce: attempt.checkr_start_nonce };
  try {
    const report = attempt.checkr_candidate_id
      ? await candidateReport(env, attempt.checkr_candidate_id)
      : null;
    if (report && attempt.checkr_candidate_id) {
      await storeReport(
        env.DB,
        scope,
        fence,
        attempt.checkr_candidate_id,
        attempt.checkr_attempt_consent_id,
        report,
      );
      return "adopted";
    }
    const waiting = reportMayArrive(attempt.checkr_report_requested_at);
    await releaseSubmission(env.DB, scope, fence, !waiting);
    return waiting ? "waiting" : "cleared";
  } catch (cause) {
    await releaseSubmission(env.DB, scope, fence, false);
    throw cause;
  }
}

/**
 * A keyed fingerprint of the details an attempt sends to Checkr, so a retry
 * can tell corrected details from the same ones without keeping them: an
 * HMAC under the Worker's secret, cleared when the attempt ends.
 */
async function attemptDigest(
  env: Bindings,
  subject: ScreeningSubject,
  { candidate, copyRequested }: ScreeningSubmission,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`checkr-attempt:${env.BETTER_AUTH_SECRET}`),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      JSON.stringify([
        subject.requirementId,
        subject.email,
        candidate.firstName,
        candidate.middleName,
        candidate.lastName,
        candidate.dob,
        candidate.ssn,
        candidate.zipcode,
        candidate.phone,
        candidate.driverLicenseNumber,
        candidate.driverLicenseState,
        copyRequested,
      ]),
    ),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function createCandidate(
  env: Bindings,
  subject: ScreeningSubject,
  submission: ScreeningSubmission,
  fence: AttemptFence,
  digest: string,
) {
  // Recorded first: if this request's response is lost, a retry with other
  // details must not replay its key and receive the old candidate.
  if (!(await markAttempt(env.DB, subject, fence, { digest }))) return null;
  const created = await rejectingDetails(() =>
    createCheckrCandidate(
      env,
      { ...submission.candidate, email: subject.email },
      subject.requirementId,
      submission.copyRequested,
      `${fence.nonce}:candidate`,
    ),
  );
  if (!created.id) throw new Error("Checkr did not return a candidate ID.");
  return (await markAttempt(env.DB, subject, fence, {
    candidateId: created.id,
  }))
    ? created.id
    : null;
}

async function uploadConsent(
  env: Bindings,
  subject: ScreeningSubject,
  candidateId: string,
  consent: { id: string; pdf: Uint8Array },
  fence: AttemptFence,
) {
  await uploadCheckrConsent(
    env,
    candidateId,
    consent.pdf,
    "background-check-authorization.pdf",
    `${fence.nonce}:consent:${consent.id}`,
  );
  if (!(await markAttempt(env.DB, subject, fence, { consentId: consent.id }))) {
    throw new AttemptChanged();
  }
}

async function requestReport(
  env: Bindings,
  subject: ScreeningSubject,
  claim: SubmitClaim,
  candidateId: string,
  fence: AttemptFence,
): Promise<StoredReport> {
  // Recorded before asking, so a retry adopts any report and waits for a
  // request whose response was lost.
  const requestedAt = new Date().toISOString();
  if (
    !(await markAttempt(env.DB, subject, fence, {
      memberUserId: subject.userId,
      requestedAt,
    }))
  ) {
    throw new AttemptChanged();
  }
  const report = await rejectingDetails(() =>
    createCheckrReport(
      env,
      candidateId,
      claim.checkr_start_package,
      subject.workState,
      subject.workCity ?? "",
      `${fence.nonce}:report`,
    ),
  );
  if (!report.id) throw new Error("Checkr did not return a report ID.");
  return {
    id: report.id,
    result: report.result ?? null,
    status: report.status,
  };
}

/** Records one step of an attempt, if the attempt is still this one. */
async function markAttempt(
  database: D1Database,
  scope: AttemptScope,
  fence: AttemptFence,
  step: {
    candidateId?: string;
    consentId?: string;
    digest?: string;
    /** Also require this person to still be the requirement's member. */
    memberUserId?: string;
    requestedAt?: string;
  },
) {
  const marked = await database
    .prepare(
      `UPDATE employee_requirements
       SET checkr_attempt_digest = COALESCE(?, checkr_attempt_digest),
           checkr_candidate_id = COALESCE(?, checkr_candidate_id),
           checkr_attempt_consent_id = COALESCE(?, checkr_attempt_consent_id),
           checkr_report_requested_at = COALESCE(?, checkr_report_requested_at),
           updated_at = ?
       WHERE id = ? AND organization_id = ? AND checkr_start_nonce = ?
         AND checkr_start_lease = ?
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM member
           WHERE member.id = employee_requirements.member_id
             AND member.organizationId = employee_requirements.organization_id
             AND member.userId = ?
         ))`,
    )
    .bind(
      step.digest ?? null,
      step.candidateId ?? null,
      step.consentId ?? null,
      step.requestedAt ?? null,
      new Date().toISOString(),
      scope.requirementId,
      scope.organizationId,
      fence.nonce,
      fence.lease,
      step.memberUserId ?? null,
      step.memberUserId ?? null,
    )
    .run();
  return marked.meta.changes > 0;
}

// Holds the screening for one submission at a time, while the person is still
// a member and the request they answered is still current. An attempt keeps its
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
           checkr_start_lease = ?, checkr_starting_at = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND kind = 'background_check'
         AND checkr_requested_at = ? AND checkr_report_id IS NULL
         AND status <> 'complete'
         AND (checkr_starting_at IS NULL OR checkr_starting_at < ?)
         AND EXISTS (
           SELECT 1 FROM member
           WHERE member.id = employee_requirements.member_id
             AND member.organizationId = employee_requirements.organization_id
             AND member.userId = ?
         )
       RETURNING checkr_attempt_consent_id, checkr_attempt_digest,
                 checkr_candidate_id, checkr_report_requested_at,
                 checkr_start_lease, checkr_start_nonce,
                 checkr_start_nonce_at, checkr_start_package`,
    )
    .bind(
      crypto.randomUUID(),
      now.toISOString(),
      subject.packageSlug,
      crypto.randomUUID(),
      now.toISOString(),
      now.toISOString(),
      subject.requirementId,
      subject.organizationId,
      subject.requestedAt,
      new Date(now.getTime() - 5 * 60_000).toISOString(),
      subject.userId,
    )
    .first<SubmitClaim>();
}

// Replaces an attempt whose candidate holds other details and never got a
// report, so corrected details go to a new candidate under new keys.
async function restartAttempt(
  database: D1Database,
  scope: AttemptScope,
  fence: AttemptFence,
) {
  const next = crypto.randomUUID();
  const now = new Date().toISOString();
  const restarted = await database
    .prepare(
      `UPDATE employee_requirements
       SET checkr_start_nonce = ?, checkr_start_nonce_at = ?,
           checkr_candidate_id = NULL, checkr_attempt_consent_id = NULL,
           checkr_attempt_digest = NULL, checkr_report_requested_at = NULL,
           updated_at = ?
       WHERE id = ? AND organization_id = ? AND checkr_start_nonce = ?
         AND checkr_start_lease = ?`,
    )
    .bind(
      next,
      now,
      now,
      scope.requirementId,
      scope.organizationId,
      fence.nonce,
      fence.lease,
    )
    .run();
  if (!restarted.meta.changes) throw new AttemptChanged();
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
  const disclosures = subject.disclosures;
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
  // Queued for cleanup until the consent row claims it, so a write that fails
  // or loses its response never leaves an untracked PDF.
  await env.DB.prepare(
    `INSERT INTO deleted_object_cleanup
       (id, organization_id, object_key, deleted_at, cleanup_token,
        cleanup_claimed_at)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
  )
    .bind(
      `screening-consent-upload:${id}`,
      subject.organizationId,
      key,
      signedAt,
    )
    .run();
  await env.STORAGE.put(key, pdf, {
    httpMetadata: { contentType: "application/pdf" },
  });
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
  return { id, pdf };
}

async function storeReport(
  database: D1Database,
  scope: AttemptScope,
  fence: AttemptFence,
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
           checkr_start_lease = NULL, checkr_start_nonce = NULL,
           checkr_start_nonce_at = NULL,
           checkr_attempt_consent_id = NULL, checkr_attempt_digest = NULL,
           checkr_report_requested_at = NULL,
           checkr_refresh_requested_at = ?,
           checkr_refresh_revision = checkr_refresh_revision + 1,
           updated_at = ?
       WHERE id = ? AND organization_id = ? AND checkr_start_nonce = ?
         AND checkr_start_lease = ?`,
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
      scope.requirementId,
      scope.organizationId,
      fence.nonce,
      fence.lease,
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
  scope: AttemptScope,
  fence: AttemptFence,
  clear: boolean,
) {
  await database
    .prepare(
      `UPDATE employee_requirements
       SET checkr_starting_at = NULL, checkr_start_lease = NULL,
           checkr_start_nonce = CASE WHEN ?1 = 1 THEN NULL ELSE checkr_start_nonce END,
           checkr_start_nonce_at = CASE WHEN ?1 = 1 THEN NULL ELSE checkr_start_nonce_at END,
           checkr_start_package = CASE WHEN ?1 = 1 THEN NULL ELSE checkr_start_package END,
           checkr_candidate_id = CASE WHEN ?1 = 1 THEN NULL ELSE checkr_candidate_id END,
           checkr_attempt_consent_id = CASE WHEN ?1 = 1 THEN NULL ELSE checkr_attempt_consent_id END,
           checkr_attempt_digest = CASE WHEN ?1 = 1 THEN NULL ELSE checkr_attempt_digest END,
           checkr_report_requested_at = CASE WHEN ?1 = 1 THEN NULL ELSE checkr_report_requested_at END,
           updated_at = ?2
       WHERE id = ?3 AND organization_id = ?4 AND checkr_start_nonce = ?5
         AND checkr_start_lease = ?6`,
    )
    .bind(
      clear ? 1 : 0,
      new Date().toISOString(),
      scope.requirementId,
      scope.organizationId,
      fence.nonce,
      fence.lease,
    )
    .run();
}
