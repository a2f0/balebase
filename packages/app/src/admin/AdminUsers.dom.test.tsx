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
    ({ container } = await mount(<AdminUsers />));
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

async function renderUsers() {
  ({ container } = await mount(
    <>
      <AdminUsers />
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

it("disables marking admin accounts", async () => {
  respond(async () =>
    Response.json({
      total: 1,
      users: [{ ...user("admin@example.com", null), role: "user, admin" }],
    }),
  );
  await renderUsers();
  expect(
    container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
      ?.disabled,
  ).toBeTrue();
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
