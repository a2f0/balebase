import { expect, it } from "bun:test";
import { join } from "node:path";
import type { Page } from "puppeteer-core";
import type {} from "./offlineAppFixture";
import { press, withOfflineBrowser } from "./offlineBrowser";

const user = {
  id: "user-1",
  name: "Inspector",
  email: "inspector@example.com",
  emailVerified: true,
};

function signedIn(id = user.id, organizationId = "org-1") {
  return {
    id: `session-${id}`,
    token: `fixture-${id}`,
    userId: id,
    activeOrganizationId: organizationId,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

/** Opens the seeded draft from its project's "On this device" list. */
async function openDraft(page: Page) {
  await page.waitForFunction(
    () => document.body.textContent?.includes("Draft"),
    { polling: 100 },
  );
  await press(page, "Continue");
  await page.waitForSelector("select");
}

/** Opens the seeded project from the device's project list. */
async function openProject(page: Page) {
  await page.waitForSelector("a.row");
  await page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>("a.row")]
      .find((link) => link.textContent?.includes("Site"))
      ?.click(),
  );
  await page.waitForFunction(
    () => location.pathname === "/projects/project-1",
    { polling: 100 },
  );
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
    await press(page, "Complete audit");
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

for (const path of ["/projects/project-1", "/"]) {
  it(`keeps an unsaved issue and photo through App revalidation after reopening ${path} offline`, async () => {
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
        // Offline without a session, the device's projects open in place of
        // any other page.
        if (path === "/") await openProject(page);
        await openDraft(page);
        const auditPath = new URL(page.url()).pathname;
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
        // Confirmed online, the device audit opens in the workspace shell.
        await page.waitForFunction(
          () =>
            document.querySelector('nav a[aria-current="page"]')
              ?.textContent === "Projects",
          { polling: 100 },
        );
        expect(new URL(page.url()).pathname).toBe(auditPath);
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
          return Response.json({ user, session: signedIn() });
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
        // Nothing changed on the server: the device keeps what it holds.
        if (pathname === "/api/offline/sync")
          return Response.json({ changed: false, cursor: "cursor-1" });
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
    // The header's back button names the audit's project.
    await press(page, "Site");
    await press(page, "Keep editing");
    expect(
      await page.$eval(
        'input[type="file"]',
        (field) => (field as HTMLInputElement).files?.[0]?.name,
      ),
    ).toBe("unsaved.png");
    expect(new URL(page.url()).pathname).toMatch(
      /^\/projects\/project-1\/audits\//,
    );
    await press(page, "Site");
    await press(page, "Discard changes");
    await page.waitForFunction(
      () => location.pathname === "/projects/project-1",
      { polling: 100 },
    );
    // A photo alone is unsaved work too.
    await openDraft(page);
    await press(page, "Raise issue");
    await (await page.$('input[type="file"]'))?.uploadFile(photo);
    await press(page, "Site");
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
    await press(page, "Raise issue");
    await press(page, "Discard changes");
    await page.waitForFunction(
      () => !document.querySelector('input[type="file"]'),
    );
    expect(
      (await page.evaluate(() => window.offlineTest.read()))?.issues,
    ).toHaveLength(0);
  });
}, 30_000);

it("lists this device's audits by sync state and opens a synced audit", async () => {
  let available = false;
  await withOfflineBrowser(
    async (page) => {
      const id = await page.evaluate(async () => {
        const auditId = await window.offlineTest.seed();
        window.offlineTest.mount();
        return auditId;
      });
      const status = () =>
        page.$eval('[role="status"]', (element) => element.textContent);
      const button = (label: string) =>
        page.waitForFunction(
          (text) =>
            [...document.querySelectorAll("button")].some(
              (entry) => entry.textContent?.trim() === text,
            ),
          { polling: 100 },
          label,
        );
      await button("Continue");
      expect(await status()).toBe(
        "Online · All completed work synced · 1 draft on this device.",
      );
      await page.evaluate(async (auditId) => {
        await window.offlineTest.answer(auditId, "pass");
        await window.offlineTest.queue(auditId);
      }, id);
      // The server is unavailable, so the completed audit waits.
      await button("View");
      await page.waitForFunction(
        () => document.body.textContent?.includes("Waiting to sync"),
        { polling: 100 },
      );
      expect(await status()).toBe("Online · 1 item waiting to sync.");
      available = true;
      await press(page, "Retry sync");
      await press(page, "Open audit");
      await page.waitForFunction(
        (auditId) =>
          location.pathname === `/audits/runs/${auditId}` &&
          document.body.textContent === "Synced audit",
        { polling: 100 },
        id,
      );
    },
    async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/offline/operations" && available) {
        const { operation } = (await request.json()) as {
          operation: { id: string };
        };
        return Response.json({ resourceId: operation.id });
      }
      return Response.json({ error: "Not available" }, { status: 503 });
    },
  );
}, 30_000);

for (const { path, kind } of [
  { path: "/add-account", kind: "account" },
  { path: "/reset-password", kind: "account" },
  { path: "/reset-password", kind: "organization" },
]) {
  it(`locks the original offline workspace when the confirmed ${kind} changes on ${path}`, async () => {
    let organizationId = "org-1";
    let current = user;
    await withOfflineBrowser(
      async (page) => {
        await page.evaluate(async (pathname) => {
          const id = await window.offlineTest.seed();
          await window.offlineTest.issue(id);
          history.replaceState(null, "", pathname);
          window.offlineAppTest.mount();
        }, path);
        await page.waitForSelector('input[type="password"]');
        if (kind === "organization") organizationId = "org-2";
        else
          current = {
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
          history.replaceState(null, "", "/projects/project-1");
          window.offlineAppTest.mount();
        });
        await page.waitForFunction(
          () => document.body.textContent?.includes("load your session"),
          { polling: 100 },
        );
        const body = await page.$eval("body", (element) => element.textContent);
        expect(body).not.toContain("On this device");
        expect(body).not.toContain("Safety inspection");
        expect(body).not.toContain("Broken rail");
        expect(body).not.toContain("inspector@example.com");
      },
      (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/auth/get-session")
          return Response.json({
            user: current,
            session: signedIn(current.id, organizationId),
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

it("opens a device audit in the workspace shell without remounting through coverage and session loss", async () => {
  let session = true;
  await withOfflineBrowser(
    async (page) => {
      await page.evaluate(async () => {
        const id = await window.offlineTest.seed();
        history.replaceState(null, "", window.offlineTest.auditPath(id));
        window.offlineAppTest.mount();
      });
      const current = 'nav a[aria-current="page"]';
      await page.waitForSelector(current);
      expect(await page.$eval(current, (link) => link.textContent)).toBe(
        "Projects",
      );
      await press(page, "Raise issue");
      const title = 'form[aria-label="Issue details"] input';
      await page.type(title, "Shell draft");
      await page.setOfflineMode(true);
      await page.waitForFunction(() => !navigator.onLine, { polling: 100 });
      await Bun.sleep(300);
      expect(await page.$(current)).not.toBeNull();
      expect(await page.$eval(title, (field) => field.value)).toBe(
        "Shell draft",
      );
      session = false;
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
        return Response.json(session ? { user, session: signedIn() } : null);
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

it("keeps a signed-in project page and its typing when coverage drops", async () => {
  await withOfflineBrowser(
    async (page) => {
      await page.evaluate(async () => {
        await window.offlineTest.seed();
        history.replaceState(null, "", "/projects");
        window.offlineAppTest.mount();
      });
      await page.waitForFunction(
        () => document.body.textContent?.includes("All projects"),
        { polling: 100 },
      );
      await press(page, "New project");
      const name = "form input";
      await page.waitForSelector(name);
      await page.type(name, "North wing");
      await page.setOfflineMode(true);
      await page.waitForFunction(() => !navigator.onLine, { polling: 100 });
      await Bun.sleep(300);
      // Still the signed-in page, not the device's copy, with the typing.
      expect(
        await page.evaluate(() =>
          document.body.textContent?.includes("as this device last synced"),
        ),
      ).toBe(false);
      expect(await page.$eval(name, (field) => field.value)).toBe("North wing");
      await page.setOfflineMode(false);
    },
    (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/auth/get-session")
        return Response.json({ user, session: signedIn() });
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
      if (pathname === "/api/projects" || pathname === "/api/projects/deleted")
        return Response.json({ canManage: true, projects: [] });
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
        history.replaceState(null, "", "/projects/project-1");
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
      await press(page, "Complete audit");
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

it("does not unlock cached work when a device sync finishes during a pending sign-out", async () => {
  let releaseSync: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseSync = resolve;
  });
  await withOfflineBrowser(
    async (page) => {
      const sync = page.waitForRequest(
        (entry) => new URL(entry.url()).pathname === "/api/offline/sync",
      );
      await page.evaluate(async () => {
        const id = await window.offlineTest.seed();
        history.replaceState(null, "", window.offlineTest.auditPath(id));
        window.offlineAppTest.mount();
      });
      await page.waitForFunction(
        () =>
          document.getElementById("session-state")?.textContent === "user-1",
        { polling: 100 },
      );
      await sync;
      await page.waitForSelector("select");
      const synced = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/offline/sync",
      );
      // The account action locks immediately, while its revocation request is
      // still pending and the current session can still sync.
      await page.evaluate(() => window.offlineTest.lock());
      releaseSync?.();
      await synced;
      await Bun.sleep(500);
      expect(
        await page.evaluate(() => window.offlineTest.activeKey()),
      ).toBeNull();
      const saved = await page.evaluate(() => window.offlineTest.read());
      // The locked device keeps its work but stores nothing from the sync.
      expect(saved?.audits).toHaveLength(1);
      expect(saved?.cursor).toBeUndefined();
      expect(saved?.forms.map((form) => form.version)).toEqual([1]);
    },
    async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/get-session")
        return Response.json({ user, session: signedIn() });
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
      if (path === "/api/offline/sync") {
        await held;
        return Response.json({
          changed: true,
          cursor: "cursor-1",
          forms: [],
          members: [user],
          projects: [],
        });
      }
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
      const auditPath = await page.evaluate(async () => {
        const id = await window.offlineTest.seed();
        // An audit's issues sync after the audit itself.
        await window.offlineTest.answer(id, "fail");
        await window.offlineTest.queue(id);
        await window.offlineTest.issue(id);
        await window.offlineTest.sync();
        const path = window.offlineTest.auditPath(id);
        window.offlineTest.mount(path);
        return path;
      });
      await press(page, "Raise issue");
      const title = 'form[aria-label="Issue details"] input';
      await page.type(title, "Do not lose this issue");
      const photo = join(directory, "keep.png");
      await Bun.write(photo, new Uint8Array([1, 2, 3, 4]));
      await (await page.$('input[type="file"]'))?.uploadFile(photo);
      await press(page, "Open synced issue");
      await page.waitForFunction(
        (path) =>
          location.pathname !== path ||
          [...document.querySelectorAll("button")].some(
            (button) => button.textContent === "Keep editing",
          ),
        { polling: 100 },
        auditPath,
      );
      expect(new URL(page.url()).pathname).toBe(auditPath);
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
