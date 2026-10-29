import { beforeAll, describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type { EmployeeRequirement } from "@balebase/validators/employeeForms";
import type {
  OrganizationMember,
  OrganizationPeopleData,
} from "@balebase/validators/organizationSettings";
import { installDom } from "../testing/dom";

const { click, fill, mount, queryButton, respond, settle } = installDom({
  url: "http://localhost:5173/organization/people",
});
let OrganizationPeople: typeof import("./OrganizationPeople").OrganizationPeople;
let container: HTMLElement;

beforeAll(async () => {
  ({ OrganizationPeople } = await import("./OrganizationPeople"));
});

function member(id: string, name: string, role = "member"): OrganizationMember {
  return {
    id,
    joinedAt: "2026-10-01T09:00:00.000Z",
    lastActiveAt: "2026-10-14T15:30:00.000Z",
    role,
    twoFactorEnabled: false,
    twoFactorRequired: false,
    user: { email: `${id}@example.com`, id: `user-${id}`, name },
  };
}

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
    dueDate: "2026-11-15",
    hasCheckrConsent: false,
    hasDocument: false,
    id: crypto.randomUUID(),
    invitationId: null,
    invitationStatus: null,
    kind: "form",
    memberId: null,
    status: "pending",
    targetEmail: null,
    targetName: null,
    title: "W-4",
    ...overrides,
  };
}

const owner = member("owner", "Olivia Owner", "owner");

/**
 * Serves people and requirements; an invitation joins the pending list, and
 * the first `failedRequests` request posts fail.
 */
function stubApi(
  people: OrganizationPeopleData,
  requirements: EmployeeRequirement[] = [],
  failedRequests = 0,
  failedListings = 0,
) {
  const invited: string[] = [];
  const requested: unknown[] = [];
  let failures = failedRequests;
  let listingFailures = failedListings;
  respond(async (url, init) => {
    if (url.pathname.endsWith("/employee-forms") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        invitationId?: string;
        requirements: Array<{ title: string }>;
      };
      requested.push(body);
      if (failures > 0) {
        failures -= 1;
        return Response.json(
          { error: "Requirement service unavailable." },
          { status: 503 },
        );
      }
      for (const draft of body.requirements) {
        requirements.push(
          requirement({
            invitationId: body.invitationId ?? null,
            targetEmail:
              people.invitations.find(({ id }) => id === body.invitationId)
                ?.email ?? null,
            title: draft.title,
          }),
        );
      }
      return Response.json({ ids: ["new"] });
    }
    if (url.pathname.endsWith("/organization/invite-member")) {
      const body = JSON.parse(String(init?.body)) as {
        email: string;
        role: string;
      };
      invited.push(body.email);
      people.invitations.push({
        email: body.email,
        expiresAt: "2026-10-11T09:00:00.000Z",
        id: `invitation-${invited.length}`,
        role: body.role,
        status: "pending",
      });
      return Response.json({ id: `invitation-${invited.length}`, ...body });
    }
    if (url.pathname.endsWith("/employee-forms")) {
      if (listingFailures > 0) {
        listingFailures -= 1;
        return Response.json(
          { error: "Requirement service unavailable." },
          { status: 503 },
        );
      }
      return Response.json({ requirements });
    }
    return Response.json(people);
  });
  return { invited, requested };
}

async function render(onNavigate: (pathname: string) => void = () => {}) {
  ({ container } = await mount(
    <>
      <OrganizationPeople
        onAccessChanged={async () => {}}
        onNavigate={onNavigate}
        organization={{ id: "org-1", name: "Acme" }}
      />
      <DialogHost />
    </>,
  ));
  await settle();
}

const inviteForm = () =>
  [...container.querySelectorAll("form")].find((form) =>
    form.textContent?.includes("Invite a member"),
  );
const inviteButton = () => queryButton("Invite member", container);
const emailField = () =>
  inviteForm()?.querySelector<HTMLInputElement>('input[name="invite-email"]') ??
  null;

describe("inviting people", () => {
  it("keeps the form open while the owner is alone, then folds it after the first invitation", async () => {
    const { invited } = stubApi({
      currentMemberId: "owner",
      invitations: [],
      memberRole: "owner",
      members: [owner],
    });
    await render();
    expect(inviteForm()).toBeTruthy();
    expect(inviteButton()).toBeNull();
    expect(queryButton("Cancel", inviteForm())).toBeNull();

    await fill(emailField(), "new@example.com");
    await click(queryButton("Send invitation", inviteForm()));

    expect(invited).toEqual(["new@example.com"]);
    expect(inviteForm()).toBeUndefined();
    expect(container.textContent).toContain(
      "Invitation sent to new@example.com with the member role.",
    );
    expect(container.textContent).toContain("Pending invitations");
    expect(document.activeElement).toBe(inviteButton());
  });

  it("keeps the form and its requests when only the requests fail, then retries them", async () => {
    const { invited, requested } = stubApi(
      {
        currentMemberId: "owner",
        invitations: [],
        memberRole: "owner",
        members: [owner],
      },
      [],
      1,
    );
    await render();
    await fill(emailField(), "new@example.com");
    await fill(
      inviteForm()?.querySelector<HTMLInputElement>("input[type=date]") ?? null,
      "2026-11-15",
    );
    await click(queryButton("Add", inviteForm()));
    await click(queryButton("Send invitation", inviteForm()));

    expect(invited).toEqual(["new@example.com"]);
    expect(inviteForm()?.textContent).toContain(
      "Invitation sent, but requirements could not be assigned",
    );
    expect(
      inviteForm()?.querySelector(".requirementDrafts")?.textContent,
    ).toContain("W-4");

    await click(queryButton("Retry requests", inviteForm()));
    expect(requested).toHaveLength(2);
    expect(requested[1]).toMatchObject({
      invitationId: "invitation-1",
      requirements: [expect.objectContaining({ title: "W-4" })],
    });
    expect(inviteForm()).toBeUndefined();
    expect(container.textContent).toContain(
      "Invitation sent to new@example.com, with its requested forms.",
    );
    // The retried request has no member page, so it shows with the others.
    expect(container.textContent).toContain("W-4 · new@example.com (invited)");
  });

  it("reports requests that could not load, and shows them after a retry", async () => {
    stubApi(
      {
        currentMemberId: "owner",
        invitations: [],
        memberRole: "owner",
        members: [owner],
      },
      [
        requirement({
          targetEmail: "former@example.com",
          title: "Credit check",
        }),
      ],
      0,
      1,
    );
    await render();
    expect(container.textContent).toContain(
      "Requested forms and checks could not be loaded.",
    );
    expect(container.textContent).not.toContain("Invitees and former members");

    await click(queryButton("Try again", container));
    expect(container.textContent).not.toContain("could not be loaded");
    expect(container.textContent).toContain(
      "Credit check · former@example.com",
    );
  });

  it("opens on demand with focus on the address, and returns focus on cancel", async () => {
    stubApi({
      currentMemberId: "owner",
      invitations: [],
      memberRole: "owner",
      members: [owner, member("mark", "Mark Member")],
    });
    await render();
    expect(inviteForm()).toBeUndefined();

    await click(inviteButton());
    expect(document.activeElement).toBe(emailField());
    await click(queryButton("Cancel", inviteForm()));
    expect(inviteForm()).toBeUndefined();
    expect(document.activeElement).toBe(inviteButton());
  });
});

describe("the member list", () => {
  it("links each member to their page and counts their open requests", async () => {
    const paths: string[] = [];
    stubApi(
      {
        currentMemberId: "owner",
        invitations: [
          {
            email: "invitee@example.com",
            expiresAt: "2026-10-11T09:00:00.000Z",
            id: "invite-1",
            role: "member",
            status: "pending",
          },
        ],
        memberRole: "owner",
        members: [
          { ...owner, lastActiveAt: null },
          member("mark", "Mark Member"),
        ],
      },
      [
        requirement({ memberId: "mark" }),
        requirement({ memberId: "mark", title: "W-9" }),
        requirement({ memberId: "mark", status: "complete", title: "I-9" }),
        requirement({
          invitationId: "invite-1",
          targetEmail: "invitee@example.com",
          title: "Background check",
        }),
        requirement({
          kind: "credit_check",
          targetEmail: "former@example.com",
          title: "Credit check",
        }),
      ],
    );
    await render((path) => paths.push(path));

    const mark = [...container.querySelectorAll("a")].find((link) =>
      link.textContent?.includes("Mark Member"),
    );
    expect(mark?.getAttribute("href")).toBe("/organization/people/mark");
    expect(mark?.textContent).toContain("2 open requests");
    expect(mark?.textContent).toContain(
      `mark@example.com · Last active ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date("2026-10-14T15:30:00.000Z"))}`,
    );
    expect(
      [...container.querySelectorAll("a")].find((link) =>
        link.textContent?.includes("Olivia Owner"),
      )?.textContent,
    ).toContain("owner@example.com · Never active");
    const unattached = [...container.querySelectorAll(".card")].find((card) =>
      card.textContent?.includes("Invitees and former members"),
    );
    expect(unattached?.textContent).toContain(
      "Background check · invitee@example.com (invited)",
    );
    expect(unattached?.textContent).toContain(
      "Credit check · former@example.com",
    );
    expect(unattached?.textContent).not.toContain("W-9");
    // Managers keep every control for requests without a member page.
    expect(
      [...(unattached?.querySelectorAll("button") ?? [])].filter(
        (element) => element.textContent?.trim() === "Remove",
      ),
    ).toHaveLength(2);
    expect(container.textContent).not.toContain("Send requests");
    await click(mark);
    expect(paths).toEqual(["/organization/people/mark"]);
  });

  it("drops organization-wide counts when the viewer stops managing", async () => {
    const people: OrganizationPeopleData = {
      currentMemberId: "adam",
      invitations: [],
      memberRole: "admin",
      members: [
        owner,
        member("adam", "Adam Admin", "admin"),
        member("mark", "Mark Member"),
      ],
    };
    const all = [
      requirement({ memberId: "mark" }),
      requirement({ memberId: "mark", title: "W-9" }),
      requirement({ memberId: "adam", title: "I-9" }),
    ];
    respond(async (url, init) => {
      if (url.pathname.endsWith("/organization/update-member-role")) {
        const body = JSON.parse(String(init?.body)) as {
          memberId: string;
          role: string;
        };
        people.memberRole = body.role;
        people.members = people.members.map((item) =>
          item.id === body.memberId ? { ...item, role: body.role } : item,
        );
        return Response.json({
          member: { id: body.memberId, role: body.role },
        });
      }
      if (url.pathname.endsWith("/employee-forms")) {
        // Like the API: managers get every request, members only their own.
        return Response.json({
          requirements:
            people.memberRole === "admin"
              ? all
              : all.filter((item) => item.memberId === "adam"),
        });
      }
      return Response.json(people);
    });
    await render();
    const row = (name: string) =>
      [...container.querySelectorAll("a")].find((link) =>
        link.textContent?.includes(name),
      );
    expect(row("Mark Member")?.textContent).toContain("2 open requests");

    await fill(
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="Role for Adam Admin"]',
      ),
      "member",
    );
    await settle();
    await settle();

    expect(row("Mark Member")?.textContent).not.toContain("open request");
    expect(container.textContent).toContain(
      "Your organization has requested a form or check from you.",
    );
  });

  it("points a member to the forms requested from them", async () => {
    const paths: string[] = [];
    stubApi(
      {
        currentMemberId: "mark",
        invitations: [],
        memberRole: "member",
        members: [owner, member("mark", "Mark Member")],
      },
      [requirement({ memberId: "mark" })],
    );
    await render((path) => paths.push(path));

    expect(inviteForm()).toBeUndefined();
    expect(inviteButton()).toBeNull();
    expect(container.textContent).not.toContain("Last active");
    expect(container.textContent).toContain(
      "Your organization has requested a form or check from you.",
    );
    const link = [...container.querySelectorAll("a")].find(
      (element) => element.textContent === "Open My documents",
    );
    await click(link);
    expect(paths).toEqual(["/me"]);
  });
});
