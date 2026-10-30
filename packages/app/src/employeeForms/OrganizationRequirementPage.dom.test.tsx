import { describe, expect, it } from "bun:test";
import type { EmployeeRequirement } from "@balebase/validators/employeeForms";
import { act } from "react";
import { installDom } from "../testing/dom";
import { OrganizationRequirementPage } from "./OrganizationRequirementPage";

const {
  button,
  fill,
  mount,
  respond,
  window: dom,
} = installDom({ url: "http://localhost:5173/organization/requests/check" });
let container: HTMLElement;

function requirement(
  overrides: Partial<EmployeeRequirement>,
): EmployeeRequirement {
  return {
    canSubmitCheckr: false,
    checkrAvailable: false,
    checkrReportStatus: null,
    checkrRequested: false,
    checkrResult: null,
    checkrSubmitting: false,
    checkrWorkLocation: null,
    completedAt: null,
    documentFilename: null,
    documentRevision: 0,
    documentSize: null,
    dueDate: "2026-10-21",
    hasCheckrConsent: false,
    hasDocument: false,
    id: "check",
    invitationId: null,
    invitationStatus: null,
    kind: "background_check",
    memberId: "member",
    status: "pending",
    targetEmail: "pat@example.com",
    targetName: "Pat Person",
    title: "Background check",
    ...overrides,
  };
}

/** Serves the organization's requests and records every change. */
function stubApi(requirements: EmployeeRequirement[]) {
  const changes: Array<{ body: unknown; method: string; url: string }> = [];
  respond(async ({ href: url }, init) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      changes.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        method,
        url,
      });
      return Response.json({ emailed: true });
    }
    return Response.json({ requirements });
  });
  return changes;
}

async function render(
  onNavigate: (pathname: string) => void = () => {},
  canManage = true,
) {
  ({ container } = await mount(
    <OrganizationRequirementPage
      canManage={canManage}
      onNavigate={onNavigate}
      requirementId="check"
    />,
  ));
}

function card(title: string) {
  const match = [...container.querySelectorAll(".card")].find((element) =>
    element.textContent?.includes(title),
  );
  if (!match) throw new Error(`No card with ${title}`);
  return match;
}

describe("a manager's request page", () => {
  it("explains a background check Balebase can't order and tracks it by hand", async () => {
    const changes = stubApi([requirement({})]);
    const paths: string[] = [];
    await render((path) => paths.push(path));

    expect(container.textContent).toContain("Requested fromPat Person");
    expect(container.textContent).toContain(
      "CheckrNot available; tracked by hand",
    );
    expect(card("Next step").textContent).toContain(
      "Checkr isn’t set up in Balebase yet",
    );
    expect(container.textContent).not.toContain("Request background check");
    const status = container.querySelector<HTMLSelectElement>(
      '[aria-label="Status for Background check"]',
    );
    expect(status?.value).toBe("pending");
    await act(async () => {
      if (status) status.value = "in_progress";
      status?.dispatchEvent(
        new dom.Event("change", { bubbles: true }) as never,
      );
    });
    expect(changes).toEqual([
      {
        body: expect.objectContaining({ status: "in_progress" }),
        method: "PATCH",
        url: "http://localhost:8787/api/employee-forms/check",
      },
    ]);

    const person = [...container.querySelectorAll("a")].find(
      (link) => link.textContent === "Pat Person",
    );
    expect(person?.getAttribute("href")).toBe("/organization/people/member");
    await act(async () =>
      person?.dispatchEvent(
        new dom.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        }) as never,
      ),
    );
    expect(paths).toEqual(["/organization/people/member"]);
  });

  it("requests a Checkr background check from the page", async () => {
    const changes = stubApi([requirement({ checkrAvailable: true })]);
    await render();

    expect(container.textContent).toContain("Not requested");
    expect(card("Next step").textContent).toContain(
      "Enter the state (and optionally the city) where Pat Person will work",
    );
    await fill(
      container.querySelector<HTMLInputElement>(
        '[aria-label="Work state for Background check"]',
      ),
      "ny",
    );
    await act(async () => button("Request background check").click());
    expect(changes).toEqual([
      {
        body: { city: "", state: "NY" },
        method: "POST",
        url: "http://localhost:8787/api/employee-forms/check/checkr/request",
      },
    ]);
    expect(container.textContent).toContain(
      "Background check requested. Pat Person was emailed a link.",
    );
  });

  it("shows the report and its result once Checkr finishes", async () => {
    stubApi([
      requirement({
        checkrAvailable: true,
        checkrReportStatus: "complete",
        checkrResult: "consider",
        checkrWorkLocation: { city: "Austin", state: "TX" },
        completedAt: "2026-10-07T11:09:40.000Z",
        hasCheckrConsent: true,
        status: "complete",
      }),
    ]);
    await render();
    expect(container.textContent).toContain("Work locationAustin, TX");
    expect(container.textContent).toContain("Report statuscomplete");
    expect(container.textContent).toContain("Checkr result: Consider");
    expect(container.textContent).toContain("Signed authorization");
    expect(card("Next step").textContent).toContain(
      "Review the report in Checkr before making a decision.",
    );
  });

  it("says when the request is gone", async () => {
    stubApi([]);
    await render();
    expect(container.textContent).toContain("This request isn’t here");
    expect(
      [...container.querySelectorAll("a")].map((link) =>
        link.getAttribute("href"),
      ),
    ).toEqual(["/organization/people"]);
  });

  it("sends members to My documents instead", async () => {
    const changes = stubApi([requirement({})]);
    await render(() => {}, false);
    expect(container.textContent).toContain(
      "Only organization managers can open requests here.",
    );
    expect(changes).toEqual([]);
  });
});
