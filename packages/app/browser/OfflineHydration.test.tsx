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

function form(id: string, name: string, version: number) {
  return {
    id,
    name,
    description: "Checklist",
    scope: "organization",
    status: "draft",
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
 * The API for one account. Change `server` to sign out, fail the next forms
 * requests, or publish new form versions.
 */
function fakeApi(projectFormIds: string[]) {
  const requests: string[] = [];
  const server = {
    failForms: 0,
    projectFormIds,
    signedIn: true,
    templates: [form("form", "Safety inspection", 2), form("roof", "Roof", 1)],
  };
  const api = (request: Request) => {
    const path = new URL(request.url).pathname;
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
    if (path === "/api/offline/forms") {
      if (server.failForms > 0) {
        server.failForms -= 1;
        return Response.json({ error: "Unavailable" }, { status: 503 });
      }
      return Response.json({
        members: [user],
        projectFormIds: server.projectFormIds,
        templates: server.templates,
      });
    }
    return Response.json([]);
  };
  const formRequests = () =>
    requests.filter((path) => path === "/api/offline/forms").length;
  return { api, formRequests, requests, server };
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

/** Waits, in real time, until `count` forms requests have been made. */
async function formsRequested(formRequests: () => number, count: number) {
  const deadline = Date.now() + 10_000;
  while (formRequests() < count && Date.now() < deadline) await Bun.sleep(50);
  expect(formRequests()).toBe(count);
}

function savedVersion(page: Page, version: number) {
  return page.waitForFunction(
    async (expected) =>
      (await window.offlineTest.read())?.templates.find(
        (entry) => entry.id === "form",
      )?.version === expected,
    { polling: 100 },
    version,
  );
}

it("downloads the forms of the person's projects when they sign in", async () => {
  const { api, formRequests } = fakeApi(["form"]);
  await withOfflineBrowser(async (page) => {
    // The device already holds version 1 of the project form.
    await page.evaluate(() => window.offlineTest.seed());
    await page.evaluate(() => window.offlineTest.lock());
    await open(page);
    await formsRequested(formRequests, 1);
    await savedVersion(page, 2);
    const saved = await page.evaluate(() => window.offlineTest.read());
    // Only project forms; started audits keep their own copy of the form.
    expect(saved?.templates.map((entry) => entry.id)).toEqual(["form"]);
    expect(saved?.audits[0]?.template.version).toBe(1);
    expect(await page.evaluate(() => window.offlineTest.activeKey())).toBe(
      saved?.key ?? "",
    );
    // Once per sign-in: reconnecting does not download again.
    await page.setOfflineMode(true);
    await page.setOfflineMode(false);
    await Bun.sleep(300);
    expect(formRequests()).toBe(1);
  }, api);
}, 30_000);

it("leaves the device untouched for someone whose projects have no forms", async () => {
  const { api, formRequests } = fakeApi([]);
  await withOfflineBrowser(async (page) => {
    await open(page);
    await formsRequested(formRequests, 1);
    await Bun.sleep(300);
    expect(
      await page.evaluate(() => window.offlineTest.read()),
    ).toBeUndefined();
    expect(
      await page.evaluate(() => window.offlineTest.activeKey()),
    ).toBeNull();
  }, api);
}, 30_000);

it("retries a failed download when the device reconnects", async () => {
  const { api, formRequests, server } = fakeApi(["form"]);
  server.failForms = 1;
  await withOfflineBrowser(async (page) => {
    await open(page);
    await formsRequested(formRequests, 1);
    await Bun.sleep(300);
    expect(
      await page.evaluate(() => window.offlineTest.read()),
    ).toBeUndefined();
    await page.setOfflineMode(true);
    await page.setOfflineMode(false);
    await formsRequested(formRequests, 2);
    await savedVersion(page, 2);
  }, api);
}, 30_000);

it("downloads again after signing out and back into the same account", async () => {
  const { api, formRequests, server } = fakeApi(["form"]);
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
    server.templates = [form("form", "Safety inspection", 3)];
    server.signedIn = true;
    await page.evaluate(() => window.offlineAppTest.refreshSession());
    await formsRequested(formRequests, 2);
    await savedVersion(page, 3);
    const saved = await page.evaluate(() => window.offlineTest.read());
    expect(await page.evaluate(() => window.offlineTest.activeKey())).toBe(
      saved?.key ?? "",
    );
  }, api);
}, 30_000);

it("does not download or unlock from the add-account page", async () => {
  const { api, formRequests } = fakeApi(["form"]);
  await withOfflineBrowser(async (page) => {
    await page.evaluate(() => window.offlineTest.seed());
    await open(page, "/add-account");
    await Bun.sleep(1_000);
    expect(formRequests()).toBe(0);
    expect(
      await page.evaluate(() => window.offlineTest.activeKey()),
    ).toBeNull();
  }, api);
}, 30_000);

it("does not unlock the device when the account signs out during the download", async () => {
  let releaseForms: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseForms = resolve;
  });
  const { api: serve, formRequests, requests } = fakeApi(["form"]);
  const api = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path !== "/api/offline/forms") return serve(request);
    requests.push(path);
    await held;
    return serve(request);
  };
  await withOfflineBrowser(async (page) => {
    await open(page);
    await formsRequested(formRequests, 1);
    // Signing out locks the device while the forms request is still open.
    await page.evaluate(() => window.offlineTest.lock());
    releaseForms?.();
    await Bun.sleep(500);
    expect(
      await page.evaluate(() => window.offlineTest.activeKey()),
    ).toBeNull();
  }, api);
}, 30_000);
