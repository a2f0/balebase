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

/** A signed-in session whose forms response names `projectFormIds`. */
function signedIn(
  projectFormIds: string[],
  templates = [form("form", "Safety inspection", 2), form("roof", "Roof", 1)],
) {
  const requests: string[] = [];
  const api = (request: Request) => {
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path === "/api/auth/get-session")
      return Response.json({
        user,
        session: {
          id: "session",
          token: "fixture",
          userId: user.id,
          activeOrganizationId: "org-1",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
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
    if (path === "/api/offline/forms")
      return Response.json({ templates, members: [user], projectFormIds });
    return Response.json([]);
  };
  return { api, requests };
}

async function signIn(page: Page, requests: string[]) {
  await page.evaluate(() => {
    history.replaceState(null, "", "/");
    window.offlineAppTest.mount();
  });
  await page.waitForFunction(
    () => document.getElementById("session-state")?.textContent === "user-1",
    { polling: 100 },
  );
  // Hydration asks for forms without anyone opening Offline work.
  const deadline = Date.now() + 10_000;
  while (!requests.includes("/api/offline/forms") && Date.now() < deadline)
    await Bun.sleep(50);
  expect(requests).toContain("/api/offline/forms");
}

it("downloads the forms of the person's projects when they sign in", async () => {
  const { api, requests } = signedIn(["form"]);
  await withOfflineBrowser(async (page) => {
    // The device already holds version 1 of the project form.
    await page.evaluate(() => window.offlineTest.seed());
    await page.evaluate(() => window.offlineTest.lock());
    await signIn(page, requests);
    await page.waitForFunction(
      async () =>
        (await window.offlineTest.read())?.templates.find(
          (entry) => entry.id === "form",
        )?.version === 2,
      { polling: 100 },
    );
    const saved = await page.evaluate(() => window.offlineTest.read());
    // Only project forms; started audits keep their own copy of the form.
    expect(saved?.templates.map((entry) => entry.id)).toEqual(["form"]);
    expect(saved?.audits[0]?.template.version).toBe(1);
    expect(await page.evaluate(() => window.offlineTest.activeKey())).toBe(
      saved?.key ?? "",
    );
    // Once per sign-in: reconnecting does not download again.
    const before = requests.filter((path) => path === "/api/offline/forms");
    await page.setOfflineMode(true);
    await page.setOfflineMode(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await Bun.sleep(300);
    expect(requests.filter((path) => path === "/api/offline/forms")).toEqual(
      before,
    );
  }, api);
}, 30_000);

it("leaves the device untouched for someone on no projects", async () => {
  const { api, requests } = signedIn([]);
  await withOfflineBrowser(async (page) => {
    await signIn(page, requests);
    await Bun.sleep(300);
    expect(
      await page.evaluate(() => window.offlineTest.read()),
    ).toBeUndefined();
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
  const { api: serve, requests } = signedIn(["form"]);
  const api = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path !== "/api/offline/forms") return serve(request);
    requests.push(path);
    await held;
    return serve(request);
  };
  await withOfflineBrowser(async (page) => {
    await signIn(page, requests);
    // Signing out locks the device while the forms request is still open.
    await page.evaluate(() => window.offlineTest.lock());
    releaseForms?.();
    await Bun.sleep(500);
    expect(
      await page.evaluate(() => window.offlineTest.activeKey()),
    ).toBeNull();
  }, api);
}, 30_000);
