import { beforeAll, describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type { EmployeeRequirement } from "@balebase/validators/employeeForms";
import type {
  OrganizationMember,
  OrganizationPeopleData,
} from "@balebase/validators/organizationSettings";
import { installDom } from "./testing/dom";

const { click, mount, queryButton, respond, settle } = installDom({
  url: "http://localhost:5173/organization/people/m",
});
let OrganizationMemberDetail: typeof import("./OrganizationMemberDetail").OrganizationMemberDetail;
let container: HTMLElement;

beforeAll(async () => {
  ({ OrganizationMemberDetail } = await import("./OrganizationMemberDetail"));
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

function requirement(memberId: string, title: string): EmployeeRequirement {
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
    id: `${memberId}-${title}`,
    invitationId: null,
    invitationStatus: null,
    kind: "form",
    memberId,
    status: "pending",
    targetEmail: null,
    targetName: null,
    title,
  };
}

const members = [
  member("owner", "Olivia Owner", "owner"),
  member("mark", "Mark Member"),
];

/** Serves people and requirements, and records every other request. */
function stubApi(viewer: { currentMemberId: string; memberRole: string }) {
  const requests: Array<{ body: unknown; path: string }> = [];
  const people: OrganizationPeopleData = {
    ...viewer,
    invitations: [],
    members: [...members],
  };
  respond(async (url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname.endsWith("/employee-forms")) {
      requests.push({ body: undefined, path: url.pathname });
      return Response.json({
        requirements: [
          requirement("mark", "W-9"),
          requirement("owner", "Owner form"),
        ],
      });
    }
    if (method === "GET") return Response.json(people);
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ body, path: url.pathname });
    if (url.pathname.endsWith("/organization/remove-member")) {
      people.members = people.members.filter(({ id }) => id !== "mark");
      return Response.json({ member: members[1] });
    }
    return Response.json({ ids: ["new"] });
  });
  return requests;
}

async function render(
  memberId: string,
  onNavigate: (pathname: string) => void = () => {},
) {
  ({ container } = await mount(
    <>
      <OrganizationMemberDetail
        memberId={memberId}
        onAccessChanged={async () => {}}
        onNavigate={onNavigate}
        organization={{ id: "org-1", name: "Acme" }}
      />
      <DialogHost />
    </>,
  ));
  await settle();
}

describe("a member's page", () => {
  it("shows a manager the member's profile and only their requests", async () => {
    const requests = stubApi({ currentMemberId: "owner", memberRole: "owner" });
    await render("mark");

    const text = container.textContent ?? "";
    expect(text).toContain("Mark Member");
    expect(text).toContain("mark@example.com");
    expect(text).toContain(
      `Joined${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date("2026-10-01T09:00:00.000Z"))}`,
    );
    expect(text).toContain(
      `Last active${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date("2026-10-14T15:30:00.000Z"))}`,
    );
    expect(text).toContain("Require 2FA");
    expect(
      container.querySelector('select[aria-label="Role for Mark Member"]'),
    ).toBeTruthy();
    expect(text).toContain("W-9");
    expect(text).not.toContain("Owner form");
    expect(queryButton("Send requests", container)).toBeTruthy();
    expect(requests).toHaveLength(1);
  });

  it("returns to the list after removing the member", async () => {
    const paths: string[] = [];
    const requests = stubApi({ currentMemberId: "owner", memberRole: "owner" });
    await render("mark", (path) => paths.push(path));

    await click(queryButton("Remove from organization", container));
    await click(
      queryButton("Remove member", document.querySelector("dialog[open]")),
    );
    expect(requests.at(-1)).toEqual({
      body: { memberIdOrEmail: "mark", organizationId: "org-1" },
      path: "/api/auth/organization/remove-member",
    });
    expect(paths).toEqual(["/organization/people"]);
  });

  it("sends a member to My documents for their own requests", async () => {
    const paths: string[] = [];
    const requests = stubApi({ currentMemberId: "mark", memberRole: "member" });
    await render("mark", (path) => paths.push(path));

    const text = container.textContent ?? "";
    expect(text).toContain("You");
    expect(text).toContain("requested from you in My documents");
    expect(text).not.toContain("W-9");
    expect(requests).toEqual([]);
    const link = [...container.querySelectorAll("a")].find(
      (element) => element.textContent === "Open My documents",
    );
    expect(link?.getAttribute("href")).toBe("/me");
    await click(link);
    expect(paths).toEqual(["/me"]);
    expect(queryButton("Send requests", container)).toBeNull();
    expect(queryButton("Remove from organization", container)).toBeNull();
    expect(text).not.toContain("Require 2FA");
    expect(text).not.toContain("Last active");
  });

  it("keeps another member's requests private", async () => {
    const requests = stubApi({ currentMemberId: "mark", memberRole: "member" });
    await render("owner");

    expect(container.textContent).toContain("Olivia Owner");
    expect(container.textContent).not.toContain("Forms and checks");
    expect(requests).toEqual([]);
  });

  it("explains when the member is no longer in the organization", async () => {
    stubApi({ currentMemberId: "owner", memberRole: "owner" });
    await render("gone");
    expect(container.textContent).toContain("This member isn’t here");
    const back = [...container.querySelectorAll("a")].find(
      (link) => link.textContent === "All people",
    );
    expect(back?.getAttribute("href")).toBe("/organization/people");
  });
});
