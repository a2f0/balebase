import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { type Browser, launch } from "puppeteer-core";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";

it("guarded Back, Forward, and links ask first and keep history entries", async () => {
  const bundle = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL("../src/navigationGuard.ts", import.meta.url)),
    ],
    target: "browser",
  });
  if (!bundle.success)
    throw new Error(
      `Navigation fixture did not bundle: ${bundle.logs.join("\n")}`,
    );
  const source = await bundle.outputs[0]?.text();
  if (!source) throw new Error("Navigation fixture is empty.");
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions());
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      void request.respond({
        contentType: "text/html",
        body: "<!doctype html><html><body></body></html>",
      });
    });
    await page.goto("https://navigation.test/", {
      waitUntil: "domcontentloaded",
    });
    const historyLength = await page.evaluate(() => history.length);
    await page.evaluate(async (code) => {
      const url = URL.createObjectURL(
        new Blob([code], { type: "text/javascript" }),
      );
      const { addNavigationGuard, canNavigate, createWorkspaceNavigation } =
        await import(url);
      URL.revokeObjectURL(url);
      const controller = createWorkspaceNavigation(
        window,
        (pathname: string) => {
          document.body.textContent = pathname;
        },
      );
      let removeGuard: (() => void) | undefined;
      // A guard stands in for unsaved work; undefined means nothing unsaved.
      Reflect.set(window, "guard", (answer: boolean | undefined) => {
        removeGuard?.();
        removeGuard =
          answer === undefined
            ? undefined
            : addNavigationGuard(async () => answer);
      });
      Reflect.set(window, "navigation", controller);
      Reflect.set(window, "canNavigate", canNavigate);
      Reflect.set(window, "navigationPops", 0);
      window.addEventListener("popstate", () =>
        Reflect.set(
          window,
          "navigationPops",
          Number(Reflect.get(window, "navigationPops")) + 1,
        ),
      );
      controller.navigate("/activity");
      controller.navigate("/contracts/templates/t1");
    }, source);
    const setGuard = (answer: boolean | undefined) =>
      page.evaluate((value) => {
        (Reflect.get(window, "guard") as (value?: boolean) => void)(
          value ?? undefined,
        );
      }, answer ?? null);
    const pops = () =>
      page.evaluate(() => Number(Reflect.get(window, "navigationPops")));
    const settled = (pathname: string, minimumPops: number) =>
      page.waitForFunction(
        (path, count) =>
          Number(Reflect.get(window, "navigationPops")) >= count &&
          location.pathname === path &&
          document.body.textContent === path,
        { timeout: 5000 },
        pathname,
        minimumPops,
      );

    // A canceled Back returns to its entry without adding one.
    await setGuard(false);
    await page.evaluate(() => history.go(-2));
    await settled("/contracts/templates/t1", 2);
    expect(await page.evaluate(() => history.length)).toBe(historyLength + 2);

    // An allowed Back returns first, then replays the move once allowed.
    await setGuard(true);
    await page.evaluate(() => history.back());
    await settled("/activity", 5);
    expect(await pops()).toBe(5);

    // A canceled Forward also restores the existing entry.
    await setGuard(false);
    await page.evaluate(() => history.forward());
    await page.waitForFunction(
      () => Number(Reflect.get(window, "navigationPops")) >= 7,
      { timeout: 5000 },
    );
    await settled("/activity", 7);
    expect(await page.evaluate(() => history.length)).toBe(historyLength + 2);

    // With nothing unsaved, Forward moves at once.
    await setGuard(undefined);
    await page.evaluate(() => history.forward());
    await settled("/contracts/templates/t1", 8);

    // In-app navigation waits for the guards too.
    await setGuard(false);
    const refused = await page.evaluate(async () => {
      (
        Reflect.get(window, "navigation") as {
          navigate: (path: string) => void;
        }
      ).navigate("/library");
      // The move awaits the same pending answer, and its handler, registered
      // first, has run by the time this await returns.
      const allowed = await (
        Reflect.get(window, "canNavigate") as () => Promise<boolean>
      )();
      return { allowed, pathname: location.pathname };
    });
    expect(refused).toEqual({
      allowed: false,
      pathname: "/contracts/templates/t1",
    });
    await setGuard(true);
    await page.evaluate(() =>
      (
        Reflect.get(window, "navigation") as {
          navigate: (path: string) => void;
        }
      ).navigate("/library"),
    );
    await settled("/library", 8);
    expect(await page.evaluate(() => history.length)).toBe(historyLength + 3);
  } finally {
    await closeChrome(browser);
  }
}, 20_000);
