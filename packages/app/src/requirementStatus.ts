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
