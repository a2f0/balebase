import { expect, it } from "bun:test";
import type { Page } from "puppeteer-core";
import type {} from "./offlineAppFixture";
import { withOfflineBrowser } from "./offlineBrowser";

const user = {
  id: "user-1",
  name: "Inspector",
  email: "inspector@example.com",
  emailVerified: true,
};
const site = {
  id: "project-1",
  name: "Site",
  description: "",
  formIds: ["form"],
};

function form(id: string, name: string, version: number) {
  return {
    id,
    name,
    description: "Checklist",
    scope: "organization",
    status: "published",
    version,
    currentVersion: version,
    createdAt: "2026-10-01T00:00:00.000Z",
    savedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    savedBy: user,
    definition: { version: 1, sections: [] },
  };
}

/**
 * The API for one account. Change `server` to sign out, fail the next sync
 * requests, or change what the person's projects hold; bump `revision` with
 * each change so the next sync answers with a new cursor.
 */
function fakeApi(projects = [site]) {
  const requests: string[] = [];
  /** The `after` cursor each sync request sent, if any. */
  const syncs: (string | null)[] = [];
  const server = {
    failSync: 0,
    forms: [form("form", "Safety inspection", 2)],
    projects,
    revision: 1,
    signedIn: true,
  };
  const api = (request: Request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    requests.push(path);
    if (path === "/api/auth/get-session")
      return Response.json(
        server.signedIn
          ? {
              user,
              session: {
                id: "session",
                token: "fixture",
                userId: user.id,
                activeOrganizationId: "org-1",
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              },
            }
          : null,
      );
    if (path === "/api/organization-settings/organizations")
      return Response.json({
        organizations: [{ id: "org-1", name: "Test team" }],
      });
    if (path === "/api/organization-groups/access")
      return Response.json({
        capabilities: [],
        memberRole: "member",
        ownerCount: 1,
      });
    if (path === "/api/offline/sync") {
      const after = url.searchParams.get("after");
      // Record a wrong scope as a cursor no assertion expects.
      syncs.push(
        url.searchParams.get("userId") === user.id &&
          url.searchParams.get("organizationId") === "org-1"
          ? after
          : "wrong scope",
      );
      if (server.failSync > 0) {
        server.failSync -= 1;
        return Response.json({ error: "Unavailable" }, { status: 503 });
      }
      const cursor = `cursor-${server.revision}`;
      if (after === cursor) return Response.json({ changed: false, cursor });
      return Response.json({
        changed: true,
        cursor,
        forms: server.forms,
        members: [user],
        projects: server.projects,
      });
    }
    return Response.json([]);
  };
  return { api, requests, server, syncs };
}

async function open(page: Page, pathname = "/") {
  await page.evaluate((path) => {
    history.replaceState(null, "", path);
    window.offlineAppTest.mount();
  }, pathname);
  await page.waitForFunction(
    () => document.getElementById("session-state")?.textContent === "user-1",
    { polling: 100 },
  );
}

/** Waits, in real time, until at least `count` sync requests have been made. */
async function syncsRequested(syncs: unknown[], count: number) {
  const deadline = Date.now() + 10_000;
  while (syncs.length < count && Date.now() < deadline) await Bun.sleep(50);
  expect(syncs.length).toBeGreaterThanOrEqual(count);
}

function savedCursor(page: Page, cursor: string) {
  return page.waitForFunction(
    async (expected) => (await window.offlineTest.read())?.cursor === expected,
    { polling: 100 },
    cursor,
  );
}

function savedVersion(page: Page, version: number) {
  return page.waitForFunction(
    async (expected) =>
      (await window.offlineTest.read())?.forms.find(
        (entry) => entry.id === "form",
      )?.version === expected,
    { polling: 100 },
    version,
  );
}

/** Drops and restores the connection, which starts another sync. */
async function reconnect(page: Page) {
  await page.setOfflineMode(true);
  await page.setOfflineMode(false);
}

it("syncs the person's projects and forms to the device when they sign in", async () => {
  const { api, syncs } = fakeApi();
  await withOfflineBrowser(async (page) => {
    // The device already holds version 1 of the project form.
    await page.evaluate(() => window.offlineTest.seed());
    await page.evaluate(() => window.offlineTest.lock());
    await open(page);
    await syncsRequested(syncs, 1);
    await savedVersion(page, 2);
    // The seeded device has never stored a sync, so it sends no cursor.
    expect(syncs[0]).toBeNull();
    const saved = await page.evaluate(() => window.offlineTest.read());
    expect(saved?.cursor).toBe("cursor-1");
    expect(saved?.projects).toEqual([site]);
    expect(saved?.forms.map((entry) => entry.id)).toEqual(["form"]);
    expect(saved?.members.map((entry) => entry.id)).toEqual([user.id]);
    // Started audits keep their own copy of the form.
    expect(saved?.audits[0]?.template.version).toBe(1);
    expect(await page.evaluate(() => window.offlineTest.activeKey())).toBe(
      saved?.key ?? "",
    );
  }, api);
}, 30_000);

it("sends its cursor on the next sync and keeps stored data when nothing changed", async () => {
  const { api, server, syncs } = fakeApi();
  await withOfflineBrowser(async (page) => {
    await open(page);
    await savedCursor(page, "cursor-1");
    const first = await page.evaluate(() => window.offlineTest.read());
    const count = syncs.length;
    await reconnect(page);
    await syncsRequested(syncs, count + 1);
    expect(syncs.at(-1)).toBe("cursor-1");
    // The server answered `changed: false`: wait for any write, then compare.
    await Bun.sleep(300);
    expect(await page.evaluate(() => window.offlineTest.read())).toEqual(first);
    // A change on the server arrives as the whole set with a new cursor.
    server.forms = [form("form", "Safety inspection", 3)];
    server.revision = 2;
    const before = syncs.length;
    await reconnect(page);
    await syncsRequested(syncs, before + 1);
    expect(syncs[before]).toBe("cursor-1");
    await savedCursor(page, "cursor-2");
    await savedVersion(page, 3);
  }, api);
}, 30_000);

it("stores an empty project list and a cursor for someone with no projects", async () => {
  const { api, server, syncs } = fakeApi([]);
  server.forms = [];
  await withOfflineBrowser(async (page) => {
    await open(page);
    await syncsRequested(syncs, 1);
    await savedCursor(page, "cursor-1");
    const saved = await page.evaluate(() => window.offlineTest.read());
    expect(saved?.projects).toEqual([]);
    expect(saved?.forms).toEqual([]);
    expect(saved?.audits).toEqual([]);
    expect(await page.evaluate(() => window.offlineTest.activeKey())).toBe(
      saved?.key ?? "",
    );
  }, api);
}, 30_000);

it("retries a failed sync when the device reconnects", async () => {
  const { api, server, syncs } = fakeApi();
  server.failSync = 1;
  await withOfflineBrowser(async (page) => {
    await open(page);
    await syncsRequested(syncs, 1);
    await Bun.sleep(300);
    // The device is prepared, but holds nothing from the failed sync.
    const prepared = await page.evaluate(() => window.offlineTest.read());
    expect(prepared?.cursor).toBeUndefined();
    expect(prepared?.forms).toEqual([]);
    expect(prepared?.projects).toEqual([]);
    await reconnect(page);
    await syncsRequested(syncs, 2);
    await savedVersion(page, 2);
    await savedCursor(page, "cursor-1");
  }, api);
}, 30_000);

it("syncs again after signing out and back into the same account", async () => {
  const { api, server, syncs } = fakeApi();
  await withOfflineBrowser(async (page) => {
    await open(page);
    await savedVersion(page, 2);
    // Sign out: the device locks, then the session ends.
    await page.evaluate(() => window.offlineTest.lock());
    server.signedIn = false;
    await page.evaluate(() => window.offlineAppTest.refreshSession());
    await page.waitForFunction(
      () =>
        document.getElementById("session-state")?.textContent === "signed-out",
      { polling: 100 },
    );
    server.forms = [form("form", "Safety inspection", 3)];
    server.revision = 2;
    const before = syncs.length;
    server.signedIn = true;
    await page.evaluate(() => window.offlineAppTest.refreshSession());
    await syncsRequested(syncs, before + 1);
    await savedVersion(page, 3);
    const saved = await page.evaluate(() => window.offlineTest.read());
    expect(saved?.cursor).toBe("cursor-2");
    expect(await page.evaluate(() => window.offlineTest.activeKey())).toBe(
      saved?.key ?? "",
    );
  }, api);
}, 30_000);

it("does not sync or unlock from the add-account page", async () => {
  const { api, syncs } = fakeApi();
  await withOfflineBrowser(async (page) => {
    await page.evaluate(() => window.offlineTest.seed());
    await open(page, "/add-account");
    await Bun.sleep(1_000);
    expect(syncs).toHaveLength(0);
    expect(
      await page.evaluate(() => window.offlineTest.activeKey()),
    ).toBeNull();
  }, api);
}, 30_000);

it("does not unlock the device when the account signs out during the sync", async () => {
  let releaseSync: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseSync = resolve;
  });
  const { api: serve, syncs } = fakeApi();
  const api = async (request: Request) => {
    if (new URL(request.url).pathname === "/api/offline/sync") await held;
    return serve(request);
  };
  await withOfflineBrowser(async (page) => {
    const request = page.waitForRequest(
      (entry) => new URL(entry.url()).pathname === "/api/offline/sync",
    );
    await open(page);
    await request;
    // Signing out locks the device while the sync request is still open.
    await page.evaluate(() => window.offlineTest.lock());
    releaseSync?.();
    await syncsRequested(syncs, 1);
    await Bun.sleep(500);
    expect(
      await page.evaluate(() => window.offlineTest.activeKey()),
    ).toBeNull();
    // The answer for the old identity was dropped, not stored.
    const saved = await page.evaluate(() => window.offlineTest.read());
    expect(saved?.cursor).toBeUndefined();
    expect(saved?.projects).toEqual([]);
  }, api);
}, 30_000);
