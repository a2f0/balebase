import type {
  EmployeeRequirement,
  EmployeeRequirementKind,
  EmployeeRequirementStatus,
} from "@balebase/validators/employeeForms";
import type { Context } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { canManage } from "../organizations/organizationMembers";
import type { Bindings } from "../types";
import { checkrConfigured } from "./checkr";
import { isClosedReportStatus } from "./checkrScreening";

export interface RequirementRow {
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

export function toRequirement(
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

function awaitingDetails(row: RequirementRow) {
  return (
    Boolean(row.checkr_requested_at) &&
    !row.checkr_report_id &&
    row.status !== "complete"
  );
}
/** Submitted to Checkr, or being submitted, and not canceled. */
export function screeningActive(row: RequirementRow) {
  return (
    row.checkr_starting_at !== null ||
    row.checkr_start_nonce !== null ||
    (row.checkr_report_id !== null &&
      !isClosedReportStatus(row.checkr_report_status))
  );
}

export async function findRequirement(context: Context<ApiEnv>) {
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

export async function canAccessRequirement(
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
