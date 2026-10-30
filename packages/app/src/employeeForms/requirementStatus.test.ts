import { describe, expect, it } from "bun:test";
import type { EmployeeRequirement } from "@balebase/validators/employeeForms";
import {
  localDate,
  managerNextStep,
  personalRequirement,
  requirementBadge,
} from "./requirementStatus";

function check(overrides: Partial<EmployeeRequirement>): EmployeeRequirement {
  return {
    canSubmitCheckr: false,
    checkrAvailable: true,
    checkrReportStatus: null,
    checkrRequested: false,
    checkrResult: null,
    checkrSubmitting: false,
    checkrWorkLocation: null,
    completedAt: null,
    documentFilename: null,
    documentRevision: 0,
    documentSize: null,
    dueDate: "2026-10-31",
    hasCheckrConsent: false,
    hasDocument: false,
    id: "check",
    invitationId: null,
    invitationStatus: null,
    kind: "background_check",
    memberId: "member",
    status: "pending",
    targetEmail: null,
    targetName: null,
    title: "Background check",
    ...overrides,
  };
}

describe("a manager's requirement badge", () => {
  it("names each Checkr stage instead of a bare pending", () => {
    expect(requirementBadge(check({}))).toEqual({
      label: "Not requested",
      tone: "neutral",
    });
    expect(requirementBadge(check({ checkrRequested: true }))).toEqual({
      label: "Waiting for details",
      tone: "info",
    });
    expect(
      requirementBadge(
        check({ checkrRequested: true, checkrSubmitting: true }),
      ),
    ).toEqual({ label: "Submitting to Checkr", tone: "info" });
    expect(
      requirementBadge(
        check({ checkrReportStatus: "pending", status: "in_progress" }),
      ),
    ).toEqual({ label: "Report in progress", tone: "info" });
    expect(
      requirementBadge(
        check({ checkrReportStatus: "suspended", status: "in_progress" }),
      ),
    ).toEqual({ label: "Report suspended", tone: "warning" });
    expect(
      requirementBadge(
        check({ checkrReportStatus: "complete", status: "complete" }),
      ),
    ).toEqual({ label: "Complete", tone: "success" });
  });

  it("shows a canceled report until a manager tracks the check by hand", () => {
    expect(requirementBadge(check({ checkrReportStatus: "canceled" }))).toEqual(
      {
        label: "Report canceled",
        tone: "warning",
      },
    );
    expect(
      requirementBadge(
        check({ checkrReportStatus: "canceled", status: "in_progress" }),
      ),
    ).toEqual({ label: "In progress", tone: "info" });
  });

  it("keeps plain statuses for forms and checks tracked by hand", () => {
    expect(requirementBadge(check({ checkrAvailable: false }))).toEqual({
      label: "Pending",
      tone: "warning",
    });
    expect(requirementBadge(check({ kind: "form" }))).toEqual({
      label: "Pending",
      tone: "warning",
    });
    expect(
      requirementBadge(check({ kind: "form", status: "submitted" })),
    ).toEqual({ label: "Submitted", tone: "info" });
  });
});

describe("a request in My documents", () => {
  const today = "2026-10-19";

  it("asks the person to act only when it's theirs to do", () => {
    expect(personalRequirement(check({ kind: "form" }), today)).toEqual({
      badge: { label: "To do", tone: "warning" },
      group: "todo",
    });
    expect(
      personalRequirement(check({ canSubmitCheckr: true }), today).group,
    ).toBe("todo");
    expect(
      personalRequirement(
        check({ canSubmitCheckr: true, checkrSubmitting: true }),
        today,
      ).badge.label,
    ).toBe("Not finished");
    expect(personalRequirement(check({}), today)).toEqual({
      badge: { label: "Not started", tone: "neutral" },
      group: "waiting",
    });
    expect(
      personalRequirement(check({ kind: "credit_check" }), today).group,
    ).toBe("waiting");
  });

  it("marks what's overdue, what's under way, and what's done", () => {
    expect(
      personalRequirement(check({ dueDate: "2026-10-18", kind: "form" }), today)
        .badge,
    ).toEqual({ label: "Overdue", tone: "danger" });
    expect(
      personalRequirement(check({ dueDate: today, kind: "form" }), today).badge
        .label,
    ).toBe("To do");
    expect(
      personalRequirement(check({ kind: "form", status: "submitted" }), today),
    ).toEqual({
      badge: { label: "In review", tone: "info" },
      group: "waiting",
    });
    expect(
      personalRequirement(
        check({ checkrReportStatus: "pending", status: "in_progress" }),
        today,
      ).badge.label,
    ).toBe("Report in progress");
    expect(personalRequirement(check({ status: "complete" }), today)).toEqual({
      badge: { label: "Complete", tone: "success" },
      group: "done",
    });
  });

  it("dates today where the person is", () => {
    expect(localDate(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });
});

describe("a manager's next step", () => {
  it("says why a check can't be ordered without Checkr", () => {
    expect(managerNextStep(check({ checkrAvailable: false }))).toBe(
      "Checkr isn’t set up in Balebase yet, so Balebase can’t order this check. Run it yourself, then set its status here as it moves along. The person sees the status in My documents.",
    );
    expect(
      managerNextStep(
        check({ checkrAvailable: false, memberId: null, targetName: "Pat" }),
      ),
    ).toBe(
      "Pat is no longer in the organization, so this check can’t be requested through Checkr.",
    );
    expect(
      managerNextStep(check({ checkrAvailable: false, kind: "credit_check" })),
    ).toContain("doesn’t order credit checks");
    expect(
      managerNextStep(
        check({ checkrReportStatus: "canceled", kind: "credit_check" }),
      ),
    ).toBe(
      "Checkr canceled this report. Run the check yourself, then set its status here.",
    );
  });

  it("walks a Checkr background check through each stage", () => {
    const pat = { targetName: "Pat" };
    expect(managerNextStep(check(pat))).toContain(
      "Enter the state (and optionally the city) where Pat will work",
    );
    expect(managerNextStep(check({ ...pat, checkrRequested: true }))).toContain(
      "Waiting for Pat to read the disclosures",
    );
    expect(
      managerNextStep(
        check({ ...pat, checkrRequested: true, checkrSubmitting: true }),
      ),
    ).toContain("Pat started submitting");
    expect(
      managerNextStep(
        check({ checkrReportStatus: "pending", status: "in_progress" }),
      ),
    ).toContain("Checkr is preparing the report.");
    expect(
      managerNextStep(check({ checkrReportStatus: "suspended" })),
    ).toContain("Checkr suspended the report");
    expect(
      managerNextStep(check({ checkrReportStatus: "canceled" })),
    ).toContain("Request the check again");
    expect(
      managerNextStep(
        check({ checkrReportStatus: "complete", status: "complete" }),
      ),
    ).toBe("Complete. Review the report in Checkr before making a decision.");
  });

  it("tells a manager when a form is theirs to review", () => {
    const form = { kind: "form" as const, targetEmail: "pat@example.com" };
    expect(managerNextStep(check(form))).toBe(
      "Waiting for pat@example.com to upload the file in My documents.",
    );
    expect(
      managerNextStep(
        check({
          ...form,
          documentFilename: "w4.pdf",
          hasDocument: true,
          status: "submitted",
        }),
      ),
    ).toBe("Download w4.pdf to review it, then set its status to Complete.");
  });
});
