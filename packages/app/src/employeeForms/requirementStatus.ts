import { productName } from "@balebase/ui/brand";
import type { BadgeTone } from "@balebase/ui/react";
import type {
  EmployeeRequirement,
  EmployeeRequirementStatus,
} from "@balebase/validators/employeeForms";

export interface StatusBadge {
  label: string;
  tone: BadgeTone;
}

/** Where a request sits in My documents. */
export type PersonalGroup = "done" | "todo" | "waiting";

const statusLabels: Record<EmployeeRequirementStatus, string> = {
  complete: "Complete",
  in_progress: "In progress",
  pending: "Pending",
  submitted: "Submitted",
};

const complete = badge("Complete", "success");

// A canceled report frees the screening to be requested again.
export function isClosedReportStatus(status: string | null) {
  return status === "canceled" || status === "partially_canceled";
}

/**
 * A manager's badge. A Checkr background check names its stage, so a check
 * waiting on the person never reads as pending beside Checkr's own pending.
 */
export function requirementBadge(requirement: EmployeeRequirement) {
  const { checkrReportStatus: report, status } = requirement;
  if (status === "complete") return complete;
  if (requirement.checkrSubmitting) {
    return badge("Submitting to Checkr", "info");
  }
  if (report && !isClosedReportStatus(report)) return reportBadge(report);
  if (requirement.checkrRequested) return badge("Waiting for details", "info");
  if (report && status === "pending") return reportBadge(report);
  if (
    requirement.kind === "background_check" &&
    requirement.checkrAvailable &&
    status === "pending"
  ) {
    return badge("Not requested", "neutral");
  }
  return badge(statusLabels[status], status === "pending" ? "warning" : "info");
}

/**
 * How a request reads to the person it was sent to: whether they have
 * something to do, are waiting on their organization, or are done.
 */
export function personalRequirement(
  requirement: EmployeeRequirement,
  today: string,
): { badge: StatusBadge; group: PersonalGroup } {
  if (requirement.status === "complete") {
    return { badge: complete, group: "done" };
  }
  if (needsPerson(requirement)) {
    const overdue = requirement.dueDate < today;
    return {
      badge: overdue
        ? badge("Overdue", "danger")
        : requirement.checkrSubmitting
          ? badge("Not finished", "warning")
          : badge("To do", "warning"),
      group: "todo",
    };
  }
  return { badge: waitingBadge(requirement), group: "waiting" };
}

/**
 * What a manager does next with a request, or who it waits on. Spells out
 * the stage the badge names, including why Balebase can't order a check.
 */
export function managerNextStep(requirement: EmployeeRequirement) {
  const person = requirement.targetName ?? requirement.targetEmail ?? "They";
  const report = requirement.checkrReportStatus;
  if (requirement.status === "complete") {
    return report
      ? "Complete. Review the report in Checkr before making a decision."
      : "Complete. Nothing more is needed.";
  }
  if (requirement.kind === "form") {
    if (!requirement.hasDocument) {
      return `Waiting for ${person} to upload the file in My documents.`;
    }
    return `Download ${requirement.documentFilename ?? "the file"} to review it, then set its status to Complete.`;
  }
  if (requirement.checkrSubmitting) {
    return `${person} started submitting their details to Checkr. It finishes when they submit the form again.`;
  }
  const reportStep = reportNextStep(requirement.checkrReportStatus);
  if (reportStep) return reportStep;
  if (requirement.checkrRequested) {
    return `Waiting for ${person} to read the disclosures, enter their details, and sign in My documents. Requesting the check emailed them a link to the form.`;
  }
  if (report) {
    // Checkr orders only background checks now, so a canceled credit report
    // is tracked by hand.
    return requirement.kind === "background_check"
      ? "Checkr canceled this report. Request the check again, or run it yourself and set its status here."
      : "Checkr canceled this report. Run the check yourself, then set its status here.";
  }
  if (requirement.checkrAvailable) {
    return `Enter the state (and optionally the city) where ${person} will work, then choose Request background check. They get an email with a link to the form in My documents.`;
  }
  if (requirement.kind === "credit_check") {
    return `${productName} doesn’t order credit checks. Run it yourself, then set its status here as it moves along.`;
  }
  if (!requirement.memberId && requirement.invitationStatus !== "pending") {
    return `${person} is no longer in the organization, so this check can’t be requested through Checkr.`;
  }
  return `Checkr isn’t set up in ${productName} yet, so ${productName} can’t order this check. Run it yourself, then set its status here as it moves along. The person sees the status in My documents.`;
}

/** The next step while Checkr holds an open report, if it does. */
function reportNextStep(report: string | null) {
  if (report === "suspended") {
    return "Checkr suspended the report while it waits for information from the person. Checkr contacts them; Refresh check updates the status here.";
  }
  if (report === "dispute") {
    return "The person disputed the report. Checkr reviews the dispute and updates the report here.";
  }
  if (report && !isClosedReportStatus(report)) {
    return "Checkr is preparing the report. Its status updates here from Checkr automatically; Refresh check updates it now.";
  }
  return undefined;
}

/** Today's date where the person is, as the YYYY-MM-DD due dates use. */
export function localDate(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function needsPerson(requirement: EmployeeRequirement) {
  if (requirement.kind === "form") return requirement.status === "pending";
  return requirement.canSubmitCheckr;
}

function waitingBadge(requirement: EmployeeRequirement) {
  const { checkrReportStatus: report, status } = requirement;
  if (requirement.kind === "form") {
    return status === "submitted"
      ? badge("In review", "info")
      : badge(statusLabels[status], "info");
  }
  if (requirement.checkrSubmitting) return badge("Submitting", "info");
  if (report && (!isClosedReportStatus(report) || status === "pending")) {
    return reportBadge(report);
  }
  return status === "pending"
    ? badge("Not started", "neutral")
    : badge(statusLabels[status], "info");
}

function reportBadge(report: string) {
  if (report === "pending") return badge("Report in progress", "info");
  if (report === "canceled") return badge("Report canceled", "warning");
  if (report === "partially_canceled") {
    return badge("Report partly canceled", "warning");
  }
  if (report === "suspended") return badge("Report suspended", "warning");
  if (report === "dispute") return badge("Report disputed", "warning");
  return badge(`Report ${report.replaceAll("_", " ")}`, "info");
}

function badge(label: string, tone: BadgeTone): StatusBadge {
  return { label, tone };
}
