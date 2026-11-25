import { describe, expect, it } from "bun:test";
import type { EmployeeRequirement } from "@balebase/validators/employeeForms";
import { PaidFeaturesContext } from "../organizations/PaidFeatures";
import { installDom } from "../testing/dom";
import { BackgroundChecks } from "./BackgroundChecks";

const { click, fill, mount, respond, settle } = installDom({
  url: "http://localhost:5173/background-checks",
});

function requirement(
  overrides: Partial<EmployeeRequirement>,
): EmployeeRequirement {
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
    dueDate: "2026-12-15",
    hasCheckrConsent: false,
    hasDocument: false,
    id: "check",
    invitationId: null,
    invitationStatus: null,
    kind: "background_check",
    memberId: "member-pat",
    status: "pending",
    targetEmail: "pat@example.com",
    targetName: "Pat Person",
    title: "Background check",
    ...overrides,
  };
}

const people = {
  currentMemberId: "member-hr",
  invitations: [],
  memberRole: "member",
  members: [
    {
      id: "member-pat",
      joinedAt: "2026-01-01T00:00:00.000Z",
      role: "member",
      user: { email: "pat@example.com", id: "pat", name: "Pat Person" },
    },
  ],
};

describe("background checks", () => {
  it("lists only background checks, each opening its own page", async () => {
    respond(async () =>
      Response.json({
        requirements: [
          requirement({ id: "check-1" }),
          requirement({
            id: "invited",
            invitationId: "invite-1",
            invitationStatus: "pending",
            memberId: null,
            targetName: null,
            targetEmail: "new@example.com",
          }),
          requirement({ id: "w4", kind: "form", title: "W-4" }),
        ],
      }),
    );
    const { container } = await mount(
      <BackgroundChecks onNavigate={() => {}} pathname="/background-checks" />,
    );
    const rows = [...container.querySelectorAll(".row")].map((row) => ({
      href: row.querySelector("a")?.getAttribute("href"),
      text: row.textContent,
    }));
    expect(rows).toEqual([
      {
        href: "/background-checks/check-1",
        text: expect.stringContaining("Pat Person"),
      },
      {
        href: "/background-checks/invited",
        text: expect.stringContaining("Invited · Due"),
      },
    ]);
    expect(container.textContent).toContain("2 checks");
    expect(container.textContent).not.toContain("W-4");
  });

  it("adds a check for the chosen person, then opens it", async () => {
    const posted: unknown[] = [];
    const visited: string[] = [];
    respond(async (url, init) => {
      if (url.pathname === "/api/organization-settings/people")
        return Response.json(people);
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return Response.json({ ids: ["created"] }, { status: 201 });
      }
      return Response.json({ requirements: [] });
    });
    const { container } = await mount(
      <PaidFeaturesContext value>
        <BackgroundChecks
          onNavigate={(path) => visited.push(path)}
          pathname="/background-checks"
        />
      </PaidFeaturesContext>,
    );
    expect(container.textContent).toContain("No background checks yet");

    await click("Request a check");
    await settle();
    await fill(container.querySelector("select"), "member:member-pat");
    await fill(
      container.querySelector<HTMLInputElement>("input[type=date]"),
      "2026-12-31",
    );
    await click("Add check");

    expect(posted).toEqual([
      {
        memberId: "member-pat",
        requirements: [
          {
            dueDate: "2026-12-31",
            kind: "background_check",
            title: "Background check",
          },
        ],
      },
    ]);
    expect(visited).toEqual(["/background-checks/created"]);
  });

  it("opens nothing for a request that answers after the page went away", async () => {
    const visited: string[] = [];
    let answer: ((response: Response) => void) | undefined;
    respond(async (url, init) => {
      if (url.pathname === "/api/organization-settings/people")
        return Response.json(people);
      if (init?.method === "POST")
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      return Response.json({ requirements: [] });
    });
    const view = await mount(
      <PaidFeaturesContext value>
        <BackgroundChecks
          onNavigate={(path) => visited.push(path)}
          pathname="/background-checks"
        />
      </PaidFeaturesContext>,
    );
    await click("Request a check");
    await settle();
    await fill(view.container.querySelector("select"), "member:member-pat");
    await fill(
      view.container.querySelector<HTMLInputElement>("input[type=date]"),
      "2026-12-31",
    );
    await click("Add check");
    expect(answer).toBeDefined();
    await view.unmount();
    answer?.(Response.json({ ids: ["late"] }, { status: 201 }));
    await settle();
    expect(visited).toEqual([]);
  });

  it("keeps the request form closed to new checks without paid features", async () => {
    respond(async (url) =>
      url.pathname === "/api/organization-settings/people"
        ? Response.json(people)
        : Response.json({ requirements: [] }),
    );
    const { container } = await mount(
      <BackgroundChecks onNavigate={() => {}} pathname="/background-checks" />,
    );
    await click("Request a check");
    await settle();
    await fill(container.querySelector("select"), "member:member-pat");
    await fill(
      container.querySelector<HTMLInputElement>("input[type=date]"),
      "2026-12-31",
    );
    expect(container.textContent).toContain(
      "Paid features are disabled for this organization.",
    );
    const add = [...container.querySelectorAll("button")].find(
      (element) => element.textContent === "Add check",
    );
    expect(add?.disabled).toBe(true);
  });

  it("shows one check's details, and none that is another kind", async () => {
    respond(async () =>
      Response.json({
        requirements: [
          requirement({ id: "check-1" }),
          requirement({ id: "w4", kind: "form", title: "W-4" }),
        ],
      }),
    );
    const check = await mount(
      <BackgroundChecks
        onNavigate={() => {}}
        pathname="/background-checks/check-1"
      />,
    );
    expect(check.container.textContent).toContain("Requested from");
    expect(check.container.textContent).toContain("Pat Person");
    // People is for owners and admins; the name links only for them.
    expect(
      check.container.querySelector('a[href^="/organization/people"]'),
    ).toBeNull();
    const managed = await mount(
      <BackgroundChecks
        canManage
        onNavigate={() => {}}
        pathname="/background-checks/check-1"
      />,
    );
    expect(
      managed.container.querySelector(
        'a[href="/organization/people/member-pat"]',
      ),
    ).toBeTruthy();
    expect(
      check.container.querySelector('a[href="/background-checks"]'),
    ).toBeTruthy();

    const form = await mount(
      <BackgroundChecks
        onNavigate={() => {}}
        pathname="/background-checks/w4"
      />,
    );
    expect(form.container.textContent).toContain(
      "This background check isn’t here",
    );
  });
});
