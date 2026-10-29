import { expect, it } from "bun:test";
import { join } from "node:path";
import type { Page } from "puppeteer-core";
import type {} from "./offlineAppFixture";
import { press, withOfflineBrowser } from "./offlineBrowser";

async function openDraft(page: Page) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some((button) =>
        button.textContent?.endsWith("· Draft"),
      ),
    { polling: 100 },
  );
  await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.endsWith("· Draft"))
      ?.click(),
  );
  await page.waitForSelector("select");
}

it("completes the latest saved answers without overwriting another tab's edit", async () => {
  await withOfflineBrowser(async (page, browser) => {
    const id = await page.evaluate(() => window.offlineTest.seed());
    await page.evaluate(async (auditId) => {
      await window.offlineTest.answer(auditId, "pass");
      window.offlineTest.mount();
    }, id);
    await openDraft(page);
    expect(await page.$eval("select", (field) => field.value)).toBe("pass");
    const other = await browser.newPage();
    await other.goto(page.url());
    await other.waitForFunction(() => Boolean(window.offlineTest));
    await other.evaluate(
      (auditId) => window.offlineTest.answer(auditId, "fail"),
      id,
    );
    await page.bringToFront();
    await press(page, "Complete and queue audit");
    await page.waitForFunction(
      async () => (await window.offlineTest.read())?.audits[0]?.queued,
      { polling: 100 },
    );
    const saved = await page.evaluate(() => window.offlineTest.read());
    expect(saved?.audits[0]?.responses).toEqual({ check: "fail" });
    const operation = saved?.jobs.find((job) => job.id === id)?.operation;
    expect(operation?.type).toBe("audit");
    if (operation?.type === "audit")
      expect(operation.responses).toEqual({ check: "fail" });
    expect(await page.$eval("select", (field) => field.value)).toBe("fail");
  });
}, 30_000);

for (const path of ["/offline", "/"]) {
  it(`keeps an unsaved issue and photo through App revalidation after reopening ${path} offline`, async () => {
    const user = {
      id: "user-1",
      name: "Inspector",
      email: "inspector@example.com",
      emailVerified: true,
    };
    let releaseAccess: (() => void) | undefined;
    const access = new Promise<void>((resolve) => {
      releaseAccess = resolve;
    });
    await withOfflineBrowser(
      async (page, _browser, directory) => {
        await page.evaluate(() => window.offlineTest.seed());
        await page.setOfflineMode(true);
        await page.evaluate((pathname) => {
          history.replaceState(null, "", pathname);
          window.offlineAppTest.mount();
        }, path);
        await openDraft(page);
        await press(page, "Raise issue");
        const title = 'form[aria-label="Issue details"] input';
        const description = 'form[aria-label="Issue details"] textarea';
        await page.type(title, "Damaged railing");
        await page.type(description, "Repair before reopening the staircase.");
        const photo = join(directory, "rail.png");
        await Bun.write(photo, new Uint8Array([1, 2, 3, 4]));
        await (await page.$('input[type="file"]'))?.uploadFile(photo);
        const request = page.waitForRequest(
          (entry) =>
            new URL(entry.url()).pathname === "/api/organization-groups/access",
        );
        await page.setOfflineMode(false);
        await page.evaluate(() => window.offlineAppTest.refreshSession());
        await request;
        // Session has returned, but organization access is deliberately unresolved.
        expect(await page.$eval(title, (field) => field.value)).toBe(
          "Damaged railing",
        );
        expect(await page.$eval(description, (field) => field.value)).toBe(
          "Repair before reopening the staircase.",
        );
        expect(
          await page.$eval(
            'input[type="file"]',
            (field) => (field as HTMLInputElement).files?.[0]?.name,
          ),
        ).toBe("rail.png");
        releaseAccess?.();
        await page.waitForFunction(
          () => !document.body.textContent?.includes("Local work only"),
          { polling: 100 },
        );
        expect(new URL(page.url()).pathname).toBe("/offline");
        expect(await page.$eval(title, (field) => field.value)).toBe(
          "Damaged railing",
        );
        await press(page, "Save issue on device");
        await page.waitForFunction(
          async () => (await window.offlineTest.read())?.issues.length === 1,
          { polling: 100 },
        );
        const issue = (await page.evaluate(() => window.offlineTest.read()))
          ?.issues[0];
        expect(issue?.operation.title).toBe("Damaged railing");
        expect(issue?.operation.description).toBe(
          "Repair before reopening the staircase.",
        );
        const image = issue?.images[0];
        if (!image) throw new Error("Selected photo was lost");
        expect(
          await page.evaluate((id) => window.offlineTest.photo(id), image.id),
        ).toEqual({ type: "image/png", bytes: [1, 2, 3, 4] });
      },
      async (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/auth/get-session")
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
        if (pathname === "/api/organization-settings/organizations")
          return Response.json({
            organizations: [{ id: "org-1", name: "Test team" }],
          });
        if (pathname === "/api/organization-groups/access") {
          await access;
          return Response.json({
            capabilities: [],
            memberRole: "owner",
            ownerCount: 1,
          });
        }
        if (pathname === "/api/offline/forms")
          return Response.json({ templates: [], members: [user] });
        return Response.json([]);
      },
    ).finally(() => releaseAccess?.());
  }, 30_000);
}

it("guards unsaved offline issue details and photos when toggling or leaving their form", async () => {
  await withOfflineBrowser(async (page, _browser, directory) => {
    await page.evaluate(async () => {
      await window.offlineTest.seed();
      window.offlineTest.mount();
    });
    await openDraft(page);
    await press(page, "Raise issue");
    const title = 'form[aria-label="Issue details"] input';
    await page.type(title, "Keep this issue");
    const photo = join(directory, "unsaved.png");
    await Bun.write(photo, new Uint8Array([1, 2, 3, 4]));
    await (await page.$('input[type="file"]'))?.uploadFile(photo);
    await press(page, "Raise issue");
    await press(page, "Keep editing");
    expect(await page.$eval(title, (field) => field.value)).toBe(
      "Keep this issue",
    );
    await press(page, "Back to offline work");
    await press(page, "Keep editing");
    expect(
      await page.$eval(
        'input[type="file"]',
        (field) => (field as HTMLInputElement).files?.[0]?.name,
      ),
    ).toBe("unsaved.png");
    await press(page, "Back to offline work");
    await press(page, "Discard changes");
    await press(page, "New offline issue");
    await (await page.$('input[type="file"]'))?.uploadFile(photo);
    await press(page, "Start offline audit");
    await press(page, "Keep editing");
    expect(
      (await page.evaluate(() => window.offlineTest.read()))?.audits,
    ).toHaveLength(1);
    expect(
      await page.$eval(
        'input[type="file"]',
        (field) => (field as HTMLInputElement).files?.[0]?.name,
      ),
    ).toBe("unsaved.png");
    await press(page, "New offline issue");
    await press(page, "Discard changes");
    await page.waitForFunction(
      () => !document.querySelector('input[type="file"]'),
    );
  });
}, 30_000);

for (const { path, kind } of [
  { path: "/add-account", kind: "account" },
  { path: "/reset-password", kind: "account" },
  { path: "/reset-password", kind: "organization" },
]) {
  it(`locks the original offline workspace when the confirmed ${kind} changes on ${path}`, async () => {
    let organizationId = "org-1";
    let user = {
      id: "user-1",
      name: "Inspector",
      email: "inspector@example.com",
      emailVerified: true,
    };
    await withOfflineBrowser(
      async (page) => {
        await page.evaluate(async (pathname) => {
          await window.offlineTest.seed();
          await window.offlineTest.issue();
          history.replaceState(null, "", pathname);
          window.offlineAppTest.mount();
        }, path);
        await page.waitForSelector('input[type="password"]');
        if (kind === "organization") organizationId = "org-2";
        else
          user = {
            ...user,
            id: "user-2",
            name: "Other",
            email: "other@example.com",
          };
        const refreshed = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/auth/get-session",
        );
        await page.evaluate(() => window.offlineAppTest.refreshSession());
        await refreshed;
        await page.waitForFunction(
          () => window.offlineTest.activeKey() === null,
          { polling: 100 },
        );
        expect(
          (await page.evaluate(() => window.offlineTest.read()))?.issues,
        ).toHaveLength(1);
        await page.reload();
        await page.waitForFunction(() => Boolean(window.offlineAppTest));
        await page.setOfflineMode(true);
        await page.evaluate(() => {
          history.replaceState(null, "", "/");
          window.offlineAppTest.mount();
        });
        await page.waitForFunction(
          () => document.body.textContent?.includes("load your session"),
          { polling: 100 },
        );
        const body = await page.$eval("body", (element) => element.textContent);
        expect(body).not.toContain("Offline work");
        expect(body).not.toContain("Broken rail");
        expect(body).not.toContain("inspector@example.com");
      },
      (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/auth/get-session")
          return Response.json({
            user,
            session: {
              id: `session-${user.id}`,
              token: `fixture-${user.id}`,
              userId: user.id,
              activeOrganizationId: organizationId,
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            },
          });
        if (pathname === "/api/organization-settings/organizations")
          return Response.json({
            organizations: [{ id: "org-1", name: "Test team" }],
          });
        if (pathname === "/api/organization-groups/access")
          return Response.json({
            capabilities: [],
            memberRole: "owner",
            ownerCount: 1,
          });
        if (pathname.startsWith("/api/offline/"))
          return Response.json({ error: "Offline fixture" }, { status: 503 });
        return Response.json([]);
      },
    );
  }, 30_000);
}

it("opens offline work in the workspace shell without remounting through coverage and session loss", async () => {
  let signedIn = true;
  const user = {
    id: "user-1",
    name: "Inspector",
    email: "inspector@example.com",
    emailVerified: true,
  };
  await withOfflineBrowser(
    async (page) => {
      await page.evaluate(async () => {
        await window.offlineTest.seed();
        history.replaceState(null, "", "/offline");
        window.offlineAppTest.mount();
      });
      const current = 'nav a[aria-current="page"]';
      await page.waitForSelector(current);
      expect(await page.$eval(current, (link) => link.textContent)).toBe(
        "Offline work",
      );
      await openDraft(page);
      await press(page, "Raise issue");
      const title = 'form[aria-label="Issue details"] input';
      await page.type(title, "Shell draft");
      await page.setOfflineMode(true);
      await page.waitForFunction(
        () => document.body.textContent?.includes("Offline ·"),
        { polling: 100 },
      );
      expect(await page.$(current)).not.toBeNull();
      expect(await page.$eval(title, (field) => field.value)).toBe(
        "Shell draft",
      );
      signedIn = false;
      await page.setOfflineMode(false);
      await page.evaluate(() => window.offlineAppTest.refreshSession());
      await page.waitForFunction(
        () =>
          document.getElementById("session-state")?.textContent ===
          "signed-out",
        { polling: 100 },
      );
      await page.waitForFunction(
        (selector) => !document.querySelector(selector),
        { polling: 100 },
        current,
      );
      expect(await page.$eval(title, (field) => field.value)).toBe(
        "Shell draft",
      );
    },
    (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/auth/get-session")
        return Response.json(
          signedIn
            ? {
                user,
                session: {
                  id: "session-user-1",
                  token: "fixture-user-1",
                  userId: user.id,
                  activeOrganizationId: "org-1",
                  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                },
              }
            : null,
        );
      if (pathname === "/api/organization-settings/organizations")
        return Response.json({
          organizations: [{ id: "org-1", name: "Test team" }],
        });
      if (pathname === "/api/organization-groups/access")
        return Response.json({
          capabilities: [],
          memberRole: "owner",
          ownerCount: 1,
        });
      if (pathname.startsWith("/api/offline/"))
        return Response.json({ error: "Offline fixture" }, { status: 503 });
      return Response.json([]);
    },
  );
}, 30_000);

it("keeps unsaved issue details and photos when reconnecting with an expired session", async () => {
  const requests: string[] = [];
  await withOfflineBrowser(
    async (page, _browser, directory) => {
      await page.evaluate(() => window.offlineTest.seed());
      await page.setOfflineMode(true);
      await page.evaluate(() => {
        history.replaceState(null, "", "/offline");
        window.offlineAppTest.mount();
      });
      await openDraft(page);
      await press(page, "Raise issue");
      const title = 'form[aria-label="Issue details"] input';
      const description = 'form[aria-label="Issue details"] textarea';
      await page.type(title, "Expired session draft");
      await page.type(description, "Keep this note and selected photo.");
      const photo = join(directory, "expired.png");
      await Bun.write(photo, new Uint8Array([1, 2, 3, 4]));
      await (await page.$('input[type="file"]'))?.uploadFile(photo);
      await page.setOfflineMode(false);
      await page.evaluate(() => window.offlineAppTest.refreshSession());
      await page.waitForFunction(
        () =>
          document.getElementById("session-state")?.textContent ===
          "signed-out",
        { polling: 100 },
      );
      expect(await page.$eval(title, (field) => field.value)).toBe(
        "Expired session draft",
      );
      expect(await page.$eval(description, (field) => field.value)).toBe(
        "Keep this note and selected photo.",
      );
      expect(
        await page.$eval(
          'input[type="file"]',
          (field) => (field as HTMLInputElement).files?.[0]?.name,
        ),
      ).toBe("expired.png");
      await press(page, "Save issue on device");
      await page.waitForFunction(
        async () => (await window.offlineTest.read())?.issues.length === 1,
        { polling: 100 },
      );
      await page.select("select", "fail");
      await press(page, "Complete and queue audit");
      await page.waitForFunction(
        async () =>
          (await window.offlineTest.read())?.jobs.some(
            (job) => job.status === "blocked",
          ),
        { polling: 100 },
      );
      const saved = await page.evaluate(() => window.offlineTest.read());
      expect(saved?.audits[0]?.queued).toBe(true);
      expect(saved?.issues[0]?.operation.title).toBe("Expired session draft");
      const image = saved?.issues[0]?.images[0];
      if (!image) throw new Error("Unsaved photo was lost on expiry");
      expect(
        await page.evaluate((id) => window.offlineTest.photo(id), image.id),
      ).toEqual({ type: "image/png", bytes: [1, 2, 3, 4] });
      expect(requests).toEqual(["audit"]);
    },
    async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/get-session") return Response.json(null);
      if (path === "/api/offline/operations") {
        const { operation } = (await request.json()) as {
          operation: { type: string };
        };
        requests.push(operation.type);
      }
      return Response.json({ error: "Sign in to sync" }, { status: 401 });
    },
  );
}, 30_000);

it("does not unlock cached work when downloads remount during a pending sign-out", async () => {
  const user = {
    id: "user-1",
    name: "Inspector",
    email: "inspector@example.com",
    emailVerified: true,
  };
  await withOfflineBrowser(
    async (page) => {
      await page.evaluate(async () => {
        await window.offlineTest.seed();
        history.replaceState(null, "", "/offline");
        window.offlineAppTest.mount();
      });
      await page.waitForFunction(
        () =>
          document.getElementById("session-state")?.textContent === "user-1" &&
          document.body.textContent?.includes("Download forms") &&
          !document.body.textContent?.includes("Loading available forms"),
        { polling: 100 },
      );
      await openDraft(page);
      const forms = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/offline/forms",
      );
      // The account action locks immediately, while its revocation request is
      // still pending and the current session can still fetch forms.
      await page.evaluate(() => window.offlineTest.lock());
      await forms;
      await page.waitForFunction(
        () =>
          !document.body.textContent?.includes("Loading available forms") ||
          document.body.textContent?.includes("active account changed"),
        { polling: 100 },
      );
      expect(
        await page.evaluate(() => window.offlineTest.activeKey()),
      ).toBeNull();
    },
    (request) => {
      const path = new URL(request.url).pathname;
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
          memberRole: "owner",
          ownerCount: 1,
        });
      if (path === "/api/offline/forms")
        return Response.json({ templates: [], members: [user] });
      return Response.json([]);
    },
  );
}, 30_000);

it("offers a download only for forms whose listed version is not on the device", async () => {
  const user = {
    id: "user-1",
    name: "Inspector",
    email: "inspector@example.com",
    emailVerified: true,
  };
  // The seeded device holds version 1 of "form"; each edit saves a new version.
  const form = (id: string, name: string, version: number) => ({
    id,
    name,
    description: "Offline checklist",
    scope: "organization",
    status: "draft",
    version,
    currentVersion: version,
    createdAt: "2026-10-01T00:00:00.000Z",
    savedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    savedBy: user,
    definition: { version: 1, sections: [] },
  });
  let listed = [form("form", "Safety inspection", 1), form("new", "Roof", 1)];
  const button = (page: Page, label: string) =>
    page.evaluate(
      (text) =>
        [...document.querySelectorAll("button")]
          .filter((entry) => entry.textContent?.trim() === text)
          .map((entry) => entry.disabled),
      label,
    );
  await withOfflineBrowser(
    async (page) => {
      await page.evaluate(async () => {
        await window.offlineTest.seed();
        history.replaceState(null, "", "/offline");
        window.offlineAppTest.mount();
      });
      await page.waitForFunction(
        () =>
          document.body.textContent?.includes("Roof · v1") &&
          !document.body.textContent?.includes("Loading available forms"),
        { polling: 100 },
      );
      expect(await button(page, "Downloaded")).toEqual([true]);
      expect(await button(page, "Update download")).toEqual([]);
      await press(page, "Download");
      await page.waitForFunction(
        async () => (await window.offlineTest.read())?.templates.length === 2,
        { polling: 100 },
      );
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll("button")].some(
            (entry) => entry.textContent?.trim() === "Download",
          ),
        { polling: 100 },
      );
      expect(await button(page, "Downloaded")).toEqual([true, true]);

      listed = [form("form", "Safety inspection", 2), form("new", "Roof", 1)];
      await page.reload();
      await page.waitForFunction(() => Boolean(window.offlineAppTest));
      await page.evaluate(() => {
        history.replaceState(null, "", "/offline");
        window.offlineAppTest.mount();
      });
      await press(page, "Update download");
      await page.waitForFunction(
        async () =>
          (await window.offlineTest.read())?.templates.find(
            (entry) => entry.id === "form",
          )?.version === 2,
        { polling: 100 },
      );
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll("button")].some(
            (entry) => entry.textContent?.trim() === "Update download",
          ),
        { polling: 100 },
      );
      expect(await button(page, "Downloaded")).toEqual([true, true]);
    },
    (request) => {
      const path = new URL(request.url).pathname;
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
          memberRole: "owner",
          ownerCount: 1,
        });
      if (path === "/api/offline/forms")
        return Response.json({ templates: listed, members: [user] });
      return Response.json([]);
    },
  );
}, 30_000);

it("guards opening a synced issue without relying on browser beforeunload protection", async () => {
  await withOfflineBrowser(
    async (page, _browser, directory) => {
      // iOS WebViews cannot rely on beforeunload. Do not let Chromium's native
      // dialog mask a missing in-app navigation guard in this regression.
      page.on("dialog", (dialog) => void dialog.accept());
      await page.evaluate(async () => {
        await window.offlineTest.seed();
        await window.offlineTest.issue();
        await window.offlineTest.sync();
        window.offlineTest.mount();
      });
      await press(page, "New offline issue");
      const title = 'form[aria-label="Issue details"] input';
      await page.type(title, "Do not lose this issue");
      const photo = join(directory, "keep.png");
      await Bun.write(photo, new Uint8Array([1, 2, 3, 4]));
      await (await page.$('input[type="file"]'))?.uploadFile(photo);
      await press(page, "Open synced issue");
      await page.waitForFunction(
        () =>
          location.pathname !== "/" ||
          [...document.querySelectorAll("button")].some(
            (button) => button.textContent === "Keep editing",
          ),
        { polling: 100 },
      );
      expect(new URL(page.url()).pathname).toBe("/");
      await press(page, "Keep editing");
      expect(await page.$eval(title, (field) => field.value)).toBe(
        "Do not lose this issue",
      );
      expect(
        await page.$eval(
          'input[type="file"]',
          (field) => (field as HTMLInputElement).files?.[0]?.name,
        ),
      ).toBe("keep.png");
      await press(page, "Open synced issue");
      await press(page, "Discard changes");
      await page.waitForFunction(
        () =>
          location.pathname.startsWith("/issues/") &&
          document.body.textContent === "Synced issue",
      );
    },
    async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/offline/operations") {
        const { operation } = (await request.json()) as {
          operation: { id: string };
        };
        return Response.json({ resourceId: operation.id });
      }
      return Response.json({ image: { id: "image" } });
    },
  );
}, 30_000);
