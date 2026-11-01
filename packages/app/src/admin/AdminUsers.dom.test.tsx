import { describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import { act } from "react";
import { installDom } from "../testing/dom";
import { AdminUsers } from "./AdminUsers";

const { button, fill, mount, respond } = installDom({
  url: "http://localhost:5173/root/users",
});
let container: HTMLElement;

function user(email: string, lastActiveAt: string | null) {
  return {
    banned: false,
    deletionRequestedAt: null as string | null,
    deletionRequestedByName: null as string | null,
    deletionRequestedByEmail: null as string | null,
    createdAt: "2026-09-01T09:00:00.000Z",
    email,
    emailVerified: true,
    id: email,
    lastActiveAt,
    name: email.split("@")[0],
    role: "user",
  };
}

describe("root admin users", () => {
  it("shows when each account was last active", async () => {
    respond(async () =>
      Response.json({
        limit: 25,
        offset: 0,
        total: 2,
        users: [
          user("active@example.com", "2026-10-14T15:30:00.000Z"),
          user("dormant@example.com", null),
        ],
      }),
    );
    ({ container } = await mount(
      <AdminUsers onNavigate={() => undefined} pathname="/root/users" />,
    ));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const headers = [...container.querySelectorAll("th")].map(
      (header) => header.textContent,
    );
    expect(headers[4]).toBe("Last active");
    const lastActive = (email: string) =>
      [...container.querySelectorAll("tr")].find((row) =>
        row.textContent?.includes(email),
      )?.children[4]?.textContent;
    expect(lastActive("active@example.com")).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
        new Date("2026-10-14T15:30:00.000Z"),
      ),
    );
    expect(lastActive("dormant@example.com")).toBe("Never");
  });
});

async function renderUsers(currentUserId?: string) {
  ({ container } = await mount(
    <>
      <AdminUsers
        currentUserId={currentUserId}
        onNavigate={() => undefined}
        pathname="/root/users"
      />
      <DialogHost />
    </>,
  ));
}

async function openUserAction(label: string) {
  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-haspopup="menu"]',
  );
  expect(trigger).toBeTruthy();
  await act(async () => trigger?.click());
  expect(document.querySelector('[role="menu"]')).toBeTruthy();
  await act(async () => button(label).click());
}

async function typeEmail(email: string) {
  await fill(document.querySelector<HTMLInputElement>("dialog input"), email);
}

it("requires email confirmation, refreshes pending status, and confirms cancellation", async () => {
  const target = user("target@example.com", null);
  const mutations: Array<{ method: string; body: unknown; path: string }> = [];
  respond(async (url, init) => {
    if (init?.method === "POST" || init?.method === "DELETE") {
      mutations.push({
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : null,
        path: url.pathname,
      });
      target.deletionRequestedAt = init.method === "POST" ? "2026-10-26" : null;
      target.deletionRequestedByEmail = "admin@example.com";
      return Response.json(
        init.method === "POST"
          ? { requestedAt: target.deletionRequestedAt }
          : { ok: true },
      );
    }
    return Response.json({ total: 1, users: [target] });
  });
  await renderUsers();
  expect(container.textContent).not.toContain("Mark for deletion");
  await openUserAction("Mark for deletion");
  expect(document.querySelector("dialog[open]")?.textContent).toContain(
    "Mark target@example.com for deletion?",
  );
  expect(button("Mark for deletion").disabled).toBeTrue();
  await typeEmail("wrong@example.com");
  expect(button("Mark for deletion").disabled).toBeTrue();
  await act(async () => button("Cancel").click());
  expect(mutations).toEqual([]);
  await openUserAction("Mark for deletion");
  await typeEmail(target.email);
  await act(async () => button("Mark for deletion").click());
  expect(mutations).toEqual([
    {
      method: "POST",
      body: { confirm: target.email },
      path: "/api/admin/users/target%40example.com/deletion",
    },
  ]);
  expect(container.textContent).toContain("Pending deletion");
  expect(container.textContent).toContain("Marked by admin@example.com");
  await openUserAction("Cancel deletion");
  await act(async () => button("Keep request").click());
  expect(mutations).toHaveLength(1);
  await openUserAction("Cancel deletion");
  await act(async () => button("Cancel deletion").click());
  expect(mutations.map(({ method }) => method)).toEqual(["POST", "DELETE"]);
  expect(container.textContent).not.toContain("Pending deletion");
});

async function openMenu() {
  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-haspopup="menu"]',
  );
  await act(async () => trigger?.click());
}

it("disables marking admin accounts but offers revoking root admin", async () => {
  respond(async () =>
    Response.json({
      total: 1,
      users: [{ ...user("admin@example.com", null), role: "user, admin" }],
    }),
  );
  await renderUsers();
  await openMenu();
  expect(button("Mark for deletion").disabled).toBeTrue();
  expect(button("Revoke root admin").disabled).toBeFalse();
});

it("offers no revoke action for accounts that are not root admins", async () => {
  respond(async () =>
    Response.json({ total: 1, users: [user("person@example.com", null)] }),
  );
  await renderUsers();
  await openMenu();
  expect(document.body.textContent).not.toContain("Revoke root admin");
});

it("confirms before revoking root admin and refreshes the row", async () => {
  const target = { ...user("admin@example.com", null), role: "user, admin" };
  const mutations: Array<{ method: string; path: string }> = [];
  respond(async (url, init) => {
    if (init?.method === "DELETE") {
      mutations.push({ method: init.method, path: url.pathname });
      target.role = "user";
      return Response.json({ ok: true });
    }
    return Response.json({ total: 1, users: [target] });
  });
  await renderUsers("someone-else");
  await openMenu();
  await act(async () => button("Revoke root admin").click());
  expect(document.querySelector("dialog[open]")?.textContent).toContain(
    "Revoke root admin for admin@example.com?",
  );
  await act(async () => button("Cancel").click());
  expect(mutations).toEqual([]);
  await openMenu();
  await act(async () => button("Revoke root admin").click());
  await act(async () => button("Revoke root admin").click());
  expect(mutations).toEqual([
    { method: "DELETE", path: "/api/admin/users/admin%40example.com/admin" },
  ]);
  expect(container.textContent).toContain(
    "admin@example.com is no longer a root admin.",
  );
  await openMenu();
  expect(document.body.textContent).not.toContain("Revoke root admin");
});

it("does not allow revoking root admin from your own account", async () => {
  const self = { ...user("me@example.com", null), role: "user, admin" };
  const mutations: string[] = [];
  respond(async (_url, init) => {
    if (init?.method && init.method !== "GET") mutations.push(init.method);
    return Response.json({ total: 1, users: [self] });
  });
  await renderUsers(self.id);
  await openMenu();
  expect(button("Revoke root admin").disabled).toBeTrue();
  await act(async () => button("Revoke root admin").click());
  expect(document.querySelector("dialog[open]")).toBeNull();
  expect(mutations).toEqual([]);
});

it("shows failed requests without changing deletion status", async () => {
  const target = user("target@example.com", null);
  respond(async (_url, init) =>
    init?.method === "POST"
      ? Response.json({ error: "Could not mark user." }, { status: 500 })
      : Response.json({ total: 1, users: [target] }),
  );
  await renderUsers();
  await openUserAction("Mark for deletion");
  await typeEmail(target.email);
  await act(async () => button("Mark for deletion").click());
  expect(container.textContent).toContain("Could not mark user.");
  expect(container.textContent).not.toContain("Pending deletion");
  expect(
    container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
      ?.disabled,
  ).toBeFalse();
});

it("keeps rows mounted while a mutation refreshes their status", async () => {
  const target = user("target@example.com", null);
  let reload: ((response: Response) => void) | undefined;
  let marked = false;
  respond((_url, init) => {
    if (init?.method === "POST") {
      marked = true;
      return Promise.resolve(Response.json({ requestedAt: "2026-10-26" }));
    }
    if (marked)
      return new Promise<Response>((resolve) => {
        reload = resolve;
      });
    return Promise.resolve(Response.json({ total: 1, users: [target] }));
  });
  await renderUsers();
  const row = container.querySelector("tbody tr");
  await openUserAction("Mark for deletion");
  await typeEmail(target.email);
  await act(async () => button("Mark for deletion").click());
  expect(container.querySelector("tbody tr")).toBe(row);
  expect(
    container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
      ?.disabled,
  ).toBeTrue();
  await act(async () =>
    reload?.(
      Response.json({
        total: 1,
        users: [{ ...target, deletionRequestedAt: "2026-10-26" }],
      }),
    ),
  );
  expect(container.querySelector("tbody tr")).toBe(row);
  expect(row?.textContent).toContain("Pending deletion");
});

it("refreshes a stale row when another admin already marked it", async () => {
  const target = user("target@example.com", null);
  respond(async (_url, init) => {
    if (init?.method === "POST") {
      target.deletionRequestedAt = "2026-10-26";
      return Response.json(
        { error: "User is already marked for deletion." },
        { status: 409 },
      );
    }
    return Response.json({ total: 1, users: [target] });
  });
  await renderUsers();
  await openUserAction("Mark for deletion");
  await typeEmail(target.email);
  await act(async () => button("Mark for deletion").click());
  expect(container.textContent).toContain(
    "User is already marked for deletion.",
  );
  expect(container.textContent).toContain("Pending deletion");
  await openUserAction("Cancel deletion");
  await act(async () => button("Keep request").click());
});

it("opens a person's platform history from the Users page", async () => {
  const target = user("target@example.com", null);
  respond(async () => Response.json({ total: 1, users: [target] }));
  const navigations: string[] = [];
  ({ container } = await mount(
    <AdminUsers
      onNavigate={(pathname) => navigations.push(pathname)}
      pathname="/root/users"
    />,
  ));
  await openUserAction("View history");
  expect(navigations).toEqual(["/root/users/target%40example.com"]);
});

it("lists role changes and deletion requests with who made them", async () => {
  const requests: string[] = [];
  respond(async (url) => {
    requests.push(`${url.pathname}${url.search}`);
    return Response.json({
      events: [
        {
          action: "deletion_canceled",
          actor: {
            email: "root@example.com",
            id: "root",
            kind: "user",
            name: "Root Admin",
          },
          id: "deletion:2",
          newRole: null,
          occurredAt: "2026-10-03T09:00:00.000Z",
          previousRole: null,
          requestedAt: "2026-10-02T09:00:00.000Z",
        },
        {
          action: "role_set",
          actor: {
            email: "ops@example.com",
            id: null,
            kind: "operator",
            name: "Ops Person",
          },
          id: "role:1",
          newRole: "admin",
          occurredAt: "2026-10-01T09:00:00.000Z",
          previousRole: "user",
          requestedAt: null,
        },
      ],
      nextCursor: null,
      user: { email: "target@example.com", id: "target", name: "Target" },
    });
  });
  const navigations: string[] = [];
  ({ container } = await mount(
    <AdminUsers
      onNavigate={(pathname) => navigations.push(pathname)}
      pathname="/root/users/target"
    />,
  ));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(requests).toEqual(["/api/admin/users/target/history"]);
  expect(container.querySelector("h1")?.textContent).toBe("Target");
  const rows = [...container.querySelectorAll(".rowList .row")].map(
    (row) => row.textContent ?? "",
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("Canceled the account's deletion");
  expect(rows[0]).toContain("Root Admin");
  expect(rows[1]).toContain("Set the platform role");
  expect(rows[1]).toContain("User → Admin");
  expect(rows[1]).toContain("Operator (auth:set-role)");
  await act(async () => button("Users").click());
  expect(navigations).toEqual(["/root/users"]);
});
