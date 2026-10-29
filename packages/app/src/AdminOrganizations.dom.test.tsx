import { describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type { AdminOrganizationDetail } from "@balebase/validators/adminOrganizations";
import { act } from "react";
import type { Root } from "react-dom/client";
import { AdminOrganizations } from "./AdminOrganizations";
import { installDom } from "./testing/dom";

const {
  fill,
  render: renderInDom,
  respond,
  window: dom,
} = installDom({ url: "http://localhost:5173/root/organizations" });
let container: HTMLElement;
let root: Root;

function detail(id = "other/org"): AdminOrganizationDetail {
  return {
    organization: {
      createdAt: "2026-10-07T11:00:00.000Z",
      deletedAt: null,
      deletedByEmail: null,
      deletedByName: null,
      deletedByUserId: null,
      id,
      memberCount: 1,
      name: `Organization ${id}`,
      ownerEmail: "pat@example.com",
      ownerName: "Pat Person",
      plaidItemCount: 3,
      slug: "other-organization",
    },
    members: [
      {
        id: "member-1",
        joinedAt: "2026-10-07T11:00:00.000Z",
        lastActiveAt: "2026-10-14T15:30:00.000Z",
        role: "owner",
        twoFactorEnabled: true,
        user: { id: "user-1", email: "pat@example.com", name: "Pat Person" },
      },
    ],
    requirements: [
      {
        checkrStatus: "complete",
        checkrReportUrl:
          "https://dashboard.checkrhq-staging.net/reports/report-1",
        checkrResult: "consider",
        completedAt: "2026-10-07T11:09:18.000Z",
        dueDate: "2026-10-31",
        id: "check-1",
        kind: "background_check",
        status: "complete",
        targetEmail: "pat@example.com",
        targetName: "Pat Person",
        title: "Background check",
      },
    ],
  };
}

async function render(
  pathname = "/root/organizations",
  onNavigate?: (path: string) => void,
) {
  const navigate = onNavigate ?? (() => {});
  ({ container, root } = await renderInDom(
    <>
      <AdminOrganizations onNavigate={navigate} pathname={pathname} />
      <DialogHost />
    </>,
  ));
}

function button(text: string) {
  const found = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(text),
  );
  if (!found) throw new Error(`No button labeled ${text}`);
  return found;
}

describe("root organization details", () => {
  it.each([0, 3])(
    "shows %i Plaid items in the list and overview",
    async (count) => {
      const fixture = detail();
      fixture.organization.plaidItemCount = count;
      respond(async (url) =>
        Response.json(
          url.href.endsWith("/other%2Forg")
            ? fixture
            : { organizations: [fixture.organization] },
        ),
      );

      await render();
      const headings = [...container.querySelectorAll("thead th")];
      const column = headings.findIndex(
        (heading) => heading.textContent === "Plaid items",
      );
      expect(column).toBeGreaterThan(-1);
      expect(
        container.querySelector("tbody tr")?.children[column]?.textContent,
      ).toBe(String(count));

      await render("/root/organizations/other%2Forg");
      const label = [...container.querySelectorAll("dt")].find(
        (element) => element.textContent === "Plaid items",
      );
      expect(label?.nextElementSibling?.textContent).toBe(String(count));
    },
  );

  it("opens the clicked organization and returns to the list using only reads", async () => {
    const fixture = detail();
    const requests: Array<{
      url: string;
      method: string;
      credentials: string | undefined;
    }> = [];
    respond(async ({ href: url }, init) => {
      requests.push({
        url,
        method: init?.method ?? "GET",
        credentials: init?.credentials,
      });
      return Response.json(
        url.endsWith("/other%2Forg")
          ? fixture
          : { organizations: [fixture.organization] },
      );
    });
    const paths: string[] = [];
    const navigate = (path: string) => {
      paths.push(path);
      root.render(<AdminOrganizations onNavigate={navigate} pathname={path} />);
    };
    await render(undefined, navigate);
    const link = container.querySelector<HTMLAnchorElement>(
      ".adminOrganizationLink",
    );
    expect(link?.getAttribute("href")).toBe("/root/organizations/other%2Forg");
    await act(async () => link?.click());
    expect(paths).toEqual(["/root/organizations/other%2Forg"]);
    expect(container.querySelector("h1")?.textContent).toBe(
      "Organization other/org",
    );
    expect(container.textContent).toContain("pat@example.com");
    const personRow = [...container.querySelectorAll("tr")].find((row) =>
      row.textContent?.includes("pat@example.com"),
    );
    expect(personRow?.lastElementChild?.textContent).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
        new Date("2026-10-14T15:30:00.000Z"),
      ),
    );
    expect(container.textContent).toContain("Background check");
    expect(container.textContent).toContain("Consider");
    expect(container.textContent).toContain("Review the report in Checkr.");
    const report =
      container.querySelector<HTMLAnchorElement>('a[target="_blank"]');
    expect(report?.href).toBe(
      fixture.requirements[0]?.checkrReportUrl ?? undefined,
    );
    expect(report?.rel).toBe("noopener noreferrer");
    await act(async () => button("Organizations").click());
    expect(paths.at(-1)).toBe("/root/organizations");
    expect(container.querySelector("h1")?.textContent).toBe("Organizations");
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "GET",
    ]);
    expect(
      requests.every((request) => request.credentials === "include"),
    ).toBeTrue();
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/admin/organizations",
      "/api/admin/organizations/other%2Forg",
      "/api/admin/organizations",
    ]);
  });

  it("keeps modified clicks available for opening a new tab", async () => {
    respond(async () =>
      Response.json({
        organizations: [detail().organization],
      }),
    );
    const paths: string[] = [];
    await render(undefined, (path) => paths.push(path));
    const link = container.querySelector<HTMLAnchorElement>(
      ".adminOrganizationLink",
    );
    const event = new dom.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    link?.dispatchEvent(event as unknown as Event);
    expect(event.defaultPrevented).toBeFalse();
    expect(paths).toEqual([]);
  });

  it("shows errors and allows retrying an empty organization", async () => {
    let attempts = 0;
    respond(async () => {
      attempts += 1;
      return attempts === 1
        ? Response.json({ error: "Organization not found." }, { status: 404 })
        : Response.json({ ...detail(), members: [], requirements: [] });
    });
    await render("/root/organizations/other%2Forg");
    expect(container.textContent).toContain("Organization not found.");
    await act(async () => button("Refresh").click());
    expect(container.textContent).not.toContain("Organization not found.");
    expect(container.textContent).toContain("No members found.");
    expect(container.textContent).toContain("No requirements assigned yet.");
  });

  it("ignores a previous organization's response after navigation", async () => {
    let finishFirst: ((response: Response) => void) | undefined;
    respond((url) =>
      url.href.endsWith("/first")
        ? new Promise<Response>((resolve) => {
            finishFirst = resolve;
          })
        : Promise.resolve(Response.json(detail("second"))),
    );
    await render("/root/organizations/first");
    expect(container.textContent).toContain("Loading organization details…");
    await render("/root/organizations/second");
    await act(async () => finishFirst?.(Response.json(detail("first"))));
    expect(container.querySelector("h1")?.textContent).toBe(
      "Organization second",
    );
    expect(container.textContent).not.toContain("Organization first");
  });
});

async function openOrganizationAction(label: string) {
  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-haspopup="menu"]',
  );
  expect(trigger).toBeTruthy();
  await act(async () => trigger?.click());
  const item = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((item) => item.textContent === label);
  expect(item).toBeTruthy();
  await act(async () => item?.click());
}

async function typeOrganizationName(value: string) {
  await fill(document.querySelector<HTMLInputElement>("dialog input"), value);
}

it("confirms organization deletion from a menu and offers confirmed restoration", async () => {
  const organization = detail().organization;
  const mutations: string[] = [];
  respond(async (_url, init) => {
    if (init?.method === "DELETE") {
      mutations.push("DELETE");
      return Response.json({
        deletedAt: "2026-10-26",
        deletedByName: "Admin",
        deletedByEmail: "admin@example.com",
        deletedByUserId: "admin",
        organizationId: organization.id,
      });
    }
    if (init?.method === "POST") {
      mutations.push("POST");
      return Response.json({ organizationId: organization.id });
    }
    return Response.json({ organizations: [organization] });
  });
  await render();
  expect(container.textContent).not.toContain("Mark for deletion");
  await openOrganizationAction("Mark for deletion");
  expect(document.querySelector("dialog[open]")?.textContent).toContain(
    `Mark ${organization.name} for deletion?`,
  );
  expect(button("Mark for deletion").disabled).toBeTrue();
  expect(mutations).toEqual([]);
  await act(async () => button("Cancel").click());
  expect(mutations).toEqual([]);
  await openOrganizationAction("Mark for deletion");
  await typeOrganizationName(organization.name);
  await act(async () => button("Mark for deletion").click());
  expect(mutations).toEqual(["DELETE"]);
  expect(container.textContent).toContain("Pending deletion");
  await openOrganizationAction("Restore");
  expect(mutations).toEqual(["DELETE"]);
  await act(async () => button("Restore").click());
  expect(mutations).toEqual(["DELETE", "POST"]);
  expect(container.textContent).not.toContain("Pending deletion");
});

it("keeps an organization active and displays a failed deletion", async () => {
  const organization = detail().organization;
  respond(async (_url, init) =>
    init?.method === "DELETE"
      ? Response.json(
          { error: "Could not mark organization." },
          { status: 500 },
        )
      : Response.json({ organizations: [organization] }),
  );
  await render();
  await openOrganizationAction("Mark for deletion");
  await typeOrganizationName(organization.name);
  await act(async () => button("Mark for deletion").click());
  expect(container.textContent).toContain("Could not mark organization.");
  expect(container.textContent).not.toContain("Pending deletion");
});
