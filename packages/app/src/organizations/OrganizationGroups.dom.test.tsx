import { beforeAll, describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type { OrganizationGroup } from "@balebase/validators/organizationGroups";
import type { OrganizationMember } from "@balebase/validators/organizationSettings";
import { installDom } from "../testing/dom";

const { click, fill, mount, queryButton, respond, settle } = installDom({
  url: "http://localhost:5173/organization/access",
});
let OrganizationAccessSettings: typeof import("./OrganizationGroups").OrganizationAccessSettings;
let container: HTMLElement;

beforeAll(async () => {
  ({ OrganizationAccessSettings } = await import("./OrganizationGroups"));
});

function member(id: string, name: string, role = "member"): OrganizationMember {
  return {
    id,
    joinedAt: "2026-10-01T09:00:00.000Z",
    role,
    user: { email: `${id}@example.com`, id: `user-${id}`, name },
  };
}

function group(
  id: string,
  name: string,
  builtIn: OrganizationGroup["builtIn"],
  memberUserIds: string[],
  capabilities: OrganizationGroup["capabilities"] = [],
): OrganizationGroup {
  return {
    builtIn,
    capabilities,
    createdAt: "2026-10-01T09:00:00.000Z",
    id,
    memberUserIds,
    name,
    updatedAt: null,
  };
}

const members = [
  member("owner", "Olivia Owner", "owner"),
  member("mark", "Mark Member"),
];
const groups = [
  group("admins", "Admins", "admins", ["user-owner"]),
  group("finance", "Finance", "finance", ["user-owner"], ["finance"]),
  group("ops", "Operations", null, ["user-mark"]),
];

/** Serves the groups and their history, and records every write. */
function stubApi() {
  const writes: Array<{ body: unknown; method: string; path: string }> = [];
  const history: string[] = [];
  respond(async (url, init) => {
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/activity")) {
      history.push(url.pathname);
      return Response.json({ events: [], nextCursor: null });
    }
    if (method === "GET") return Response.json({ groups, members });
    writes.push({
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      method,
      path: url.pathname,
    });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ id: "ops" });
  });
  return { history, writes };
}

async function render(groupId?: string, onNavigate = (_: string) => {}) {
  ({ container } = await mount(
    <>
      <OrganizationAccessSettings
        groupId={groupId}
        onAccessChanged={async () => undefined}
        onNavigate={onNavigate}
        organizationId="org-1"
      />
      <DialogHost />
    </>,
  ));
  await settle();
}

const tabs = () =>
  [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);

describe("organization groups", () => {
  it("lists groups as compact rows that open each group", async () => {
    stubApi();
    const paths: string[] = [];
    await render(undefined, (path) => paths.push(path));
    const rows = [
      ...container.querySelectorAll<HTMLAnchorElement>(".groupRow"),
    ];
    expect(rows.map((row) => row.textContent)).toEqual([
      "AdminsBuilt-in1 member · Owners and admins",
      "FinanceBuilt-in1 member · Finance access",
      "Operations1 member · No feature access",
    ]);
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([
      "/organization/access/groups/admins",
      "/organization/access/groups/finance",
      "/organization/access/groups/ops",
    ]);
    // No member pickers or delete buttons on the list itself.
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(queryButton("Delete group", container)).toBeNull();
    await click(rows[2]);
    expect(paths).toEqual(["/organization/access/groups/ops"]);
  });

  it("keeps the built-in Finance group: editable, never deletable", async () => {
    const { history, writes } = stubApi();
    await render("finance");
    expect(container.textContent).toContain("but not delete it");
    expect(queryButton("Delete group", container)).toBeNull();
    expect(tabs()).toEqual(["Members", "Access", "History"]);
    expect(history).toEqual(["/api/organization-groups/finance/activity"]);

    // Add Mark on Members, rename on Access, and save both together.
    const mark = [...container.querySelectorAll("label.groupMemberOption")]
      .find((label) => label.textContent?.includes("Mark Member"))
      ?.querySelector("input");
    await click(mark);
    await click(queryButton("Access", container));
    const name = container.querySelector<HTMLInputElement>(
      ".groupNameField input",
    );
    await fill(name, "Accounts");
    await click(queryButton("Save group", container));
    expect(writes).toEqual([
      {
        body: {
          capabilities: ["finance"],
          name: "Accounts",
          userIds: ["user-owner", "user-mark"],
        },
        method: "PATCH",
        path: "/api/organization-groups/finance",
      },
    ]);
  });

  it("shows the Admins group read-only, with role changes as its history", async () => {
    const { writes } = stubApi();
    await render("admins");
    expect(tabs()).toEqual(["Members", "History"]);
    expect(container.textContent).toContain("Olivia Owner");
    expect(container.textContent).not.toContain("Mark Member");
    expect(container.textContent).toContain("Change roles in People");
    expect(container.textContent).toContain("Role changes");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(queryButton("Delete group", container)).toBeNull();
    expect(writes).toEqual([]);
  });

  it("deletes a group of the organization's own and returns to the list", async () => {
    const { writes } = stubApi();
    const paths: string[] = [];
    await render("ops", (path) => paths.push(path));
    await click(queryButton("Delete group", container));
    await click(
      queryButton("Delete group", document.querySelector("dialog[open]")),
    );
    await settle();
    expect(writes).toEqual([
      {
        body: undefined,
        method: "DELETE",
        path: "/api/organization-groups/ops",
      },
    ]);
    expect(paths).toEqual(["/organization/access"]);
  });

  it("says when a group is gone", async () => {
    stubApi();
    await render("missing");
    expect(container.textContent).toContain("This group isn’t here");
  });
});
