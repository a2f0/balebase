import type { ActivityEvent } from "@balebase/validators/activity";
import { textValue } from "./activityLabels";

const requirementKinds: Record<string, string> = {
  background_check: "Background check",
  credit_check: "Credit check",
  form: "Form",
};

const requirementStatuses: Record<string, string> = {
  complete: "Complete",
  in_progress: "In progress",
  pending: "Pending",
  submitted: "Submitted",
};

const contractStatuses: Record<string, string> = {
  completed: "Completed",
  declined: "Declined",
  draft: "Draft",
  sent: "Awaiting signatures",
  voided: "Voided",
};

/**
 * Labels for contract and screening events no person, or the person the
 * request is for, records: the signing workflow's, Checkr's, and the person's
 * own submission.
 */
export const contractActionLabels: Record<string, string> = {
  "contract.completed": "completed a contract",
  "contract.declined": "recorded a signer's decline",
  "employee_requirement.screening_report_adopted":
    "adopted a background check report",
  "employee_requirement.screening_submitted": "submitted a background check",
  "employee_requirement.screening_updated": "updated a background check",
};

const screeningRefreshes: Record<string, string> = {
  manual: "Refreshed by hand",
  scheduled: "Scheduled refresh",
  webhook: "Checkr update",
};

function reportStatus(value: unknown) {
  const text = textValue(value).replaceAll("_", " ");
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "None";
}

function count(value: unknown, one: string, many: string) {
  const amount = typeof value === "number" ? value : 0;
  return `${amount} ${amount === 1 ? one : many}`;
}

function label(labels: Record<string, string>, value: unknown) {
  const text = textValue(value);
  return labels[text] ?? (text || "None");
}

/** What a contract or contract template event changed, on one line. */
export function contractActivitySummary({ action, details }: ActivityEvent) {
  switch (action) {
    case "contract.created":
      return details.templateName
        ? `From ${textValue(details.templateName)} · v${textValue(details.templateVersion)}`
        : "Uploaded a PDF";
    case "contract.sent":
      return [
        count(details.signerCount, "signer", "signers"),
        details.signingOrder === "sequential" ? "In order" : "In parallel",
        details.dueDate ? `Due ${textValue(details.dueDate)}` : "No due date",
      ].join(" · ");
    case "contract.voided":
      return [
        `${textValue(details.signedCount) || "0"} of ${count(details.signerCount, "signer", "signers")} signed`,
        details.reason ? `Reason: ${textValue(details.reason)}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "contract.declined":
      return `A signer declined · ${textValue(details.signedCount) || "0"} of ${count(details.signerCount, "signer", "signers")} had signed`;
    case "contract.completed":
      return `Every signer signed · ${count(details.signerCount, "signer", "signers")}`;
    case "contract.deleted":
      return [
        `Was ${label(contractStatuses, details.status)}`,
        typeof details.signedCount === "number"
          ? `${details.signedCount} of ${count(details.signerCount, "signer", "signers")} signed`
          : count(details.signerCount, "signer", "signers"),
        details.templateName
          ? `From ${textValue(details.templateName)} · v${textValue(details.templateVersion)}`
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "contract_template.created":
      return `Version 1 · ${count(details.pageCount, "page", "pages")}`;
    case "contract_template.version_saved":
      return [
        `Version ${textValue(details.version)} from v${textValue(details.sourceVersion)}`,
        details.previousName && details.previousName !== details.name
          ? `Renamed from ${textValue(details.previousName)}`
          : "",
        count(details.roleCount, "role", "roles"),
        count(details.fieldCount, "field", "fields"),
      ]
        .filter(Boolean)
        .join(" · ");
    case "contract_template.deleted":
      return `Version ${textValue(details.version)} · ${count(details.versionCount, "version", "versions")} removed`;
    default:
      return textValue(details.title) || "Details";
  }
}

/** What a change to a form or check requested of a person was, on one line. */
export function requirementActivitySummary({
  action,
  details,
  root,
}: ActivityEvent) {
  const person =
    textValue(details.personName) || textValue(details.personEmail);
  const kind = label(requirementKinds, details.kind);
  const heading = `${textValue(details.title) || root.label} · ${kind}${person ? ` · ${person}` : ""}`;
  return `${heading} · ${requirementChange(action, details)}`;
}

function requirementChange(action: string, details: ActivityEvent["details"]) {
  switch (action) {
    case "employee_requirement.assigned":
      return `Due ${textValue(details.dueDate)}`;
    case "employee_requirement.due_date_changed":
      return `Due ${textValue(details.before)} → ${textValue(details.after)}`;
    case "employee_requirement.status_changed":
      return `${label(requirementStatuses, details.before)} → ${label(requirementStatuses, details.after)} (set by hand${details.checkrReport ? ", Checkr report on file" : ""})`;
    case "employee_requirement.deleted":
      return `Was ${label(requirementStatuses, details.status)}${
        typeof details.consentsRemoved === "number" &&
        details.consentsRemoved > 0
          ? ` · ${count(details.consentsRemoved, "signed authorization", "signed authorizations")} removed`
          : ""
      }`;
    case "employee_requirement.document_uploaded":
      return [
        `Revision ${textValue(details.revision)}`,
        details.uploadedBySubject ? "By the person" : "By a manager",
        details.replaced ? "Replaced the previous file" : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "employee_requirement.screening_requested":
      return [
        `Work location: ${[textValue(details.workCity), textValue(details.workState)].filter(Boolean).join(", ")}`,
        details.rerequest ? "Requested again" : "",
        details.previousReportId
          ? `Replaces report ${textValue(details.previousReportId)}`
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
    default:
      return screeningChange(action, details);
  }
}

/** What Checkr, a refresh, or the person's submission did to a screening. */
function screeningChange(action: string, details: ActivityEvent["details"]) {
  switch (action) {
    case "employee_requirement.screening_updated":
      return [
        `Report ${reportStatus(details.previousReportStatus)} → ${reportStatus(details.reportStatus)}`,
        details.previousStatus === details.status
          ? ""
          : `${label(requirementStatuses, details.previousStatus)} → ${label(requirementStatuses, details.status)}`,
        details.resultChanged ? "Result updated" : "",
        screeningRefreshes[textValue(details.via)] ?? "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "employee_requirement.screening_submitted":
      return details.adopted
        ? `Found the report an earlier submission ordered · ${reportStatus(details.reportStatus)}`
        : `Signed the authorization and ordered the report · ${reportStatus(details.reportStatus)}`;
    case "employee_requirement.screening_report_adopted":
      return `Adopted the report an unfinished submission ordered · ${reportStatus(details.reportStatus)}`;
    default:
      return "Details";
  }
}
