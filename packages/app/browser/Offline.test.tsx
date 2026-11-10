import { expect, it } from "bun:test";
import { type Browser, launch } from "puppeteer-core";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";
import { type AppliedOperation, appliedReply } from "./offlineBrowser";
import type {} from "./offlineFixture";

/** The fixture page's script, built as the app builds for browsers. */
async function fixtureScript() {
  const build = await Bun.build({
    entrypoints: [new URL("./offlineFixture.tsx", import.meta.url).pathname],
    target: "browser",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"VITE_API_URL":"","PROD":false}',
    },
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  return build.outputs[0]?.text();
}

const fixturePage =
  '<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>';

it("persists audits and photos across reload, retries in dependency order, and isolates tabs and accounts", async () => {
  const script = await fixtureScript();
  const requests: string[] = [];
  const received = new Set<string>();
  let loseResponse = true;
  let deny = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture.js")
        return new Response(script, {
          headers: { "content-type": "text/javascript" },
        });
      if (path === "/api/offline/operations") {
        const { operation } = (await request.json()) as {
          operation: AppliedOperation;
        };
        requests.push(operation.type);
        if (deny)
          return Response.json(
            { error: "Original account required" },
            { status: 403 },
          );
        received.add(operation.id);
        if (loseResponse) {
          loseResponse = false;
          return Response.json(
            { error: "Response lost after commit" },
            { status: 503 },
          );
        }
        return Response.json(appliedReply(operation));
      }
      if (path.includes("/images/")) {
        requests.push("image");
        received.add(path.split("/").at(-1) ?? "");
        expect(Array.from(new Uint8Array(await request.arrayBuffer()))).toEqual(
          [1, 2, 3, 4],
        );
        return Response.json({ image: { id: "image" } });
      }
      return new Response(fixturePage, {
        headers: { "content-type": "text/html" },
      });
    },
  });
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions({ protocolTimeout: 20_000 }));
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => Boolean(window.offlineTest));
    const auditId = await page.evaluate(() => window.offlineTest.seed());
    await page.setOfflineMode(true);
    await page.evaluate(async (id) => {
      await window.offlineTest.answer(id, "fail");
      await window.offlineTest.issue(id);
    }, auditId);
    expect(
      await page.evaluate((id) => window.offlineTest.answers(id), auditId),
    ).toEqual({ check: "fail" });
    await page.evaluate(() => window.offlineTest.sync());
    expect(requests).toEqual([]);
    await page.setOfflineMode(false);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.offlineTest));
    const restored = await page.evaluate(() => window.offlineTest.read());
    expect(restored?.issues).toHaveLength(1);
    expect(
      await page.evaluate((id) => window.offlineTest.answers(id), auditId),
    ).toEqual({ check: "fail" });
    const imageId = restored?.issues[0]?.images[0]?.id;
    if (!imageId) throw new Error("Image was not persisted");
    expect(
      await page.evaluate((id) => window.offlineTest.photo(id), imageId),
    ).toEqual({ type: "image/png", bytes: [1, 2, 3, 4] });
    expect(
      await page.evaluate(() => window.offlineTest.other()),
    ).toBeUndefined();
    await page.evaluate(() =>
      window.offlineTest.abort().catch(() => undefined),
    );
    expect(
      (await page.evaluate(() => window.offlineTest.read()))?.forms,
    ).toHaveLength(1);
    // Raising the issue put its audit on the server first. That response is
    // lost, so the issue and its photo keep waiting for it.
    await page.evaluate(() => window.offlineTest.sync());
    expect(requests).toEqual(["auditStart"]);
    expect(
      (await page.evaluate(() => window.offlineTest.read()))?.jobs.every(
        (job) => job.status === "pending",
      ),
    ).toBe(true);
    await page.evaluate(() => window.offlineTest.retry());
    const otherTab = await browser.newPage();
    await otherTab.goto(server.url.href);
    await otherTab.waitForFunction(() => Boolean(window.offlineTest));
    await Promise.all([
      page.evaluate(() => window.offlineTest.sync()),
      otherTab.evaluate(() => window.offlineTest.sync()),
    ]);
    expect(requests).toEqual(["auditStart", "auditStart", "issue", "image"]);
    expect(received.size).toBe(3);
    expect(
      (await page.evaluate(() => window.offlineTest.read()))?.jobs.every(
        (job) => job.status === "synced",
      ),
    ).toBe(true);
    // A different authenticated account cannot drain the saved account's work.
    deny = true;
    await page.evaluate((id) => window.offlineTest.issue(id), auditId);
    await page.evaluate(() => window.offlineTest.sync());
    expect(
      (await page.evaluate(() => window.offlineTest.read()))?.jobs.filter(
        (job) => job.status === "blocked",
      ),
    ).toHaveLength(1);
    const count = requests.length;
    await page.evaluate(() => {
      window.offlineTest.lock();
      return window.offlineTest.retry();
    });
    await page.evaluate(() => window.offlineTest.sync());
    expect(requests).toHaveLength(count);
    await page.bringToFront();
    await page.evaluate((id) => {
      window.offlineTest.activate();
      window.offlineTest.mount(window.offlineTest.auditPath(id));
    }, auditId);
    await page.waitForFunction(() =>
      document.body.textContent?.includes("Broken rail"),
    );
    expect(
      await page.$$eval("img", (images) =>
        images.every((image) => image.src.startsWith("blob:")),
      ),
    ).toBe(true);
  } finally {
    await closeChrome(browser);
    await server.stop(true);
  }
}, 30_000);

it("syncs a shared audit both ways: sends answers, takes each write's outcome, and reads changes made elsewhere", async () => {
  const script = await fixtureScript();
  const sent: { type: string; answers: Record<string, unknown> }[] = [];
  // The server's copy; `keep` makes it keep its own answer to `check`, as a
  // later answer given online would.
  interface Answer {
    at: string;
    value: string;
    version: string;
  }
  const copy: {
    answers: { [itemId: string]: Answer | undefined; check?: Answer };
    revision: number;
    status: string;
  } = { answers: {}, revision: 0, status: "in_progress" };
  let keep = false;
  // The audit is gone, though a write's receipt still replays.
  let gone = false;
  const state = (id: string) => ({ ...copy, deleted: false, id });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture.js")
        return new Response(script, {
          headers: { "content-type": "text/javascript" },
        });
      if (path === "/api/offline/operations") {
        const { operation } = (await request.json()) as {
          operation: {
            answers: Record<string, { at: string; value: string }>;
            auditId?: string;
            id: string;
            type: string;
          };
        };
        sent.push({ answers: operation.answers, type: operation.type });
        for (const [itemId, { at, value }] of Object.entries(operation.answers))
          if (!keep)
            copy.answers[itemId] = { at, value, version: operation.id };
        copy.revision += 1;
        const auditId = operation.auditId ?? operation.id;
        if (gone) return Response.json({ resourceId: auditId });
        return Response.json({ audit: state(auditId), resourceId: auditId });
      }
      if (path.startsWith("/api/offline/audits/"))
        return Response.json(state(path.split("/").at(-1) ?? ""));
      return new Response(fixturePage, {
        headers: { "content-type": "text/html" },
      });
    },
  });
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions({ protocolTimeout: 20_000 }));
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => Boolean(window.offlineTest));
    const id = await page.evaluate(() => window.offlineTest.seed());
    const audit = async () =>
      (await page.evaluate(() => window.offlineTest.read()))?.audits[0];
    const answers = () =>
      page.evaluate((auditId) => window.offlineTest.answers(auditId), id);
    const answerAndSync = (value: string) =>
      page.evaluate(
        async (auditId, answer) => {
          await window.offlineTest.answer(auditId, answer);
          await window.offlineTest.sync();
        },
        id,
        value,
      );

    // Sharing sends the draft's answers, and the server's copy confirms them.
    await page.evaluate(async (auditId) => {
      await window.offlineTest.answer(auditId, "pass");
      await window.offlineTest.progress(auditId);
      await window.offlineTest.sync();
    }, id);
    // The start's answers take its ID, the audit's, as their version.
    expect(copy.answers.check?.version).toBe(id);
    expect(sent.map(({ type }) => type)).toEqual(["auditStart"]);
    expect(await audit()).toMatchObject({
      local: {},
      sending: [],
      server: { answers: { check: { value: "pass" } }, revision: 1 },
      status: "inProgress",
    });

    // A later answer goes out by itself, over the answer it replaced.
    await answerAndSync("fail");
    expect(sent.at(-1)).toEqual({
      answers: {
        check: { at: expect.any(String), base: id, value: "fail" },
      },
      type: "auditSave",
    });
    expect(await audit()).toMatchObject({ local: {}, sending: [] });

    // The server keeps a later answer given online; the device shows it and
    // notes that it replaced this device's.
    keep = true;
    copy.answers.check = {
      at: "2099-01-01T00:00:00.000Z",
      value: "na",
      version: "online-1",
    };
    await answerAndSync("pass");
    expect(await answers()).toEqual({ check: "na" });
    expect((await audit())?.replaced).toEqual({
      check: { at: expect.any(String), value: "pass" },
    });

    // Reading the server's copy brings in what changed elsewhere, and a
    // completion made elsewhere seals the audit here.
    copy.answers.check = {
      at: "2099-01-02T00:00:00.000Z",
      value: "fail",
      version: "online-2",
    };
    copy.revision += 1;
    await page.evaluate(() => window.offlineTest.pull());
    expect(await answers()).toEqual({ check: "fail" });
    copy.status = "completed";
    copy.revision += 1;
    await page.evaluate(() => window.offlineTest.pull());
    expect((await audit())?.status).toBe("completed");

    // An answer still being written when it was sealed goes out anyway. A
    // write whose receipt outlived its audit comes back without a copy: it
    // stays unsynced with the reason, and its answer still shows.
    gone = true;
    await answerAndSync("na");
    const held = await page.evaluate(() => window.offlineTest.read());
    expect(held?.jobs.at(-1)).toMatchObject({
      error:
        "This audit is no longer on the server. Your local work has been kept.",
      status: "blocked",
    });
    expect(await answers()).toEqual({ check: "na" });
  } finally {
    await closeChrome(browser);
    await server.stop(true);
  }
}, 30_000);
