import { describe, expect, it } from "bun:test";
import type { EmployeeRequirement } from "@balebase/validators/employeeForms";
import { act } from "react";
import { EmployeeForms } from "./EmployeeForms";
import { installDom } from "./testing/dom";

const { button, fill, mount, respond } = installDom({
  url: "http://localhost:5173/organization/people",
});
let container: HTMLElement;

function screening(
  overrides: Partial<EmployeeRequirement>,
): EmployeeRequirement {
  return {
    canSubmitCheckr: false,
    checkrAvailable: true,
    checkrReportStatus: "complete",
    checkrRequested: false,
    checkrResult: null,
    checkrSubmitting: false,
    checkrWorkLocation: { city: "San Jose", state: "CA" },
    completedAt: null,
    documentFilename: null,
    documentRevision: 0,
    documentSize: null,
    dueDate: "2026-10-31",
    hasCheckrConsent: true,
    hasDocument: false,
    id: "screening",
    invitationId: null,
    invitationStatus: null,
    kind: "background_check",
    memberId: "member",
    status: "in_progress",
    targetEmail: "person@example.com",
    targetName: "Pat Person",
    title: "Background check",
    ...overrides,
  };
}

async function render(requirements: EmployeeRequirement[]) {
  respond(async () => Response.json({ requirements }));
  ({ container } = await mount(
    <EmployeeForms scope={{ kind: "member", memberId: "member" }} />,
  ));
}

function badgeText(within: Element) {
  return within.querySelector(".requirementItemHeader .badge")?.textContent;
}

function item(title: string) {
  const match = [...container.querySelectorAll(".requirementItem")].find(
    (element) => element.querySelector("strong")?.textContent === title,
  );
  if (!match) throw new Error(`No requirement titled ${title}`);
  return match;
}

describe("requesting forms on a member's page", () => {
  it("lists only that member's requests and sends new ones to them", async () => {
    const posted: unknown[] = [];
    respond(async (_url, init) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return Response.json({ ids: ["new"] });
      }
      return Response.json({
        requirements: [
          screening({ id: "own", title: "Own check" }),
          screening({
            id: "other",
            memberId: "someone-else",
            title: "Their check",
          }),
        ],
      });
    });
    ({ container } = await mount(
      <EmployeeForms scope={{ kind: "member", memberId: "member" }} />,
    ));
    expect(item("Own check")).toBeTruthy();
    expect(container.textContent).not.toContain("Their check");

    await fill(
      container.querySelector<HTMLInputElement>(
        ".requirementEditor input[type=date]",
      ),
      "2026-11-15",
    );
    await act(async () => button("Add").click());
    await act(async () => button("Send requests").click());

    expect(posted).toEqual([
      {
        memberId: "member",
        requirements: [
          expect.objectContaining({
            dueDate: "2026-11-15",
            kind: "form",
            title: "W-4",
          }),
        ],
      },
    ]);
  });
});

describe("Checkr screening results", () => {
  it("shows the result, completion date, and review guidance", async () => {
    await render([
      screening({
        checkrResult: "clear",
        completedAt: "2026-10-07T11:09:40.000Z",
        id: "clear",
        status: "complete",
        title: "Clear check",
      }),
      screening({
        checkrResult: "consider",
        completedAt: "2026-10-07T11:09:40.000Z",
        id: "consider",
        status: "complete",
        title: "Consider check",
      }),
      screening({
        checkrReportStatus: "pending",
        id: "pending",
        title: "Pending check",
      }),
    ]);

    const clear = item("Clear check");
    const clearBadge = clear.querySelector(".checkrResult .badge");
    expect(clearBadge?.textContent).toBe("Checkr result: Clear");
    expect(clearBadge?.className).toContain("badgeSuccess");
    const completedOn = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
    }).format(new Date("2026-10-07T11:09:40.000Z"));
    expect(clear.textContent).toContain(`Completed ${completedOn}`);
    expect(clear.textContent).not.toContain("Review it in Checkr");
    expect(clear.textContent).not.toContain("Checkr: complete");
    expect(clear.textContent).toContain("Refresh check");
    expect(clear.textContent).toContain("Signed authorization");

    const consider = item("Consider check");
    const considerBadge = consider.querySelector(".checkrResult .badge");
    expect(considerBadge?.textContent).toBe("Checkr result: Consider");
    expect(considerBadge?.className).toContain("badgeWarning");
    expect(consider.textContent).toContain(
      "The report found records to review. Review it in Checkr before making a decision.",
    );

    const pending = item("Pending check");
    expect(pending.querySelector(".checkrResult")).toBeNull();
    expect(badgeText(pending)).toBe("Report in progress");
    expect(pending.textContent).not.toContain("Checkr: pending");
  });

  it("keeps the report status beside a result from a canceled report", async () => {
    await render([
      screening({
        checkrReportStatus: "partially_canceled",
        checkrResult: "consider",
        status: "pending",
        title: "Partial check",
      }),
    ]);

    const partial = item("Partial check");
    expect(partial.textContent).toContain("Checkr result: Consider");
    expect(badgeText(partial)).toBe("Report partly canceled");
    expect(partial.textContent).toContain("Request again");
  });

  it("keeps refreshing a credit report ordered through a hosted invitation", async () => {
    await render([
      screening({
        checkrAvailable: false,
        checkrReportStatus: "pending",
        kind: "credit_check",
        title: "Credit check",
      }),
    ]);
    const credit = item("Credit check");
    expect(badgeText(credit)).toBe("Report in progress");
    expect(button("Refresh check", credit)).toBeTruthy();
  });

  it("does not offer to request a canceled credit report again", async () => {
    await render([
      screening({
        checkrAvailable: false,
        checkrReportStatus: "canceled",
        kind: "credit_check",
        status: "pending",
        title: "Credit check",
      }),
    ]);
    const credit = item("Credit check");
    expect(badgeText(credit)).toBe("Report canceled");
    expect(credit.textContent).not.toContain("Request again");
    expect(
      credit.querySelector('[aria-label="Status for Credit check"]'),
    ).toBeTruthy();
  });
});

describe("requesting a Checkr background check", () => {
  it("requests a check at a work location and says whether the person was emailed", async () => {
    const posted: Array<{ body: unknown; url: string }> = [];
    let requested = false;
    respond(async (url, init) => {
      if (init?.method === "POST") {
        posted.push({
          body: JSON.parse(String(init.body)),
          url: url.href,
        });
        requested = true;
        return Response.json({ emailed: false });
      }
      return Response.json({
        requirements: [
          screening({
            checkrReportStatus: null,
            checkrRequested: requested,
            checkrWorkLocation: requested
              ? { city: "Austin", state: "TX" }
              : null,
            hasCheckrConsent: false,
            status: "pending",
          }),
        ],
      });
    });
    ({ container } = await mount(
      <EmployeeForms scope={{ kind: "member", memberId: "member" }} />,
    ));
    const check = item("Background check");
    expect(badgeText(check)).toBe("Not requested");
    for (const [label, value] of [
      ["Work state for Background check", "tx"],
      ["Work city for Background check", "Austin"],
    ] as const) {
      await fill(
        check.querySelector<HTMLInputElement>(`[aria-label="${label}"]`),
        value,
      );
    }
    await act(async () => button("Request background check", check).click());
    expect(posted).toEqual([
      {
        body: { city: "Austin", state: "TX" },
        url: "http://localhost:8787/api/employee-forms/screening/checkr/request",
      },
    ]);
    expect(container.textContent).toContain(
      "Background check requested, but the email to Pat Person couldn’t be sent.",
    );
    const waiting = item("Background check");
    expect(badgeText(waiting)).toBe("Waiting for details");
    expect(button("Update request", waiting)).toBeTruthy();
    expect(
      waiting.querySelector<HTMLInputElement>(
        '[aria-label="Work state for Background check"]',
      )?.value,
    ).toBe("TX");
  });
});
