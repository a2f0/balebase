import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { type Browser, launch } from "puppeteer-core";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";
import { stylesheets } from "./stylesheets";

it("returns from a transaction to Finance's rows and scroll on Back", async () => {
  const built = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL("./financeBackFixture.tsx", import.meta.url)),
    ],
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    target: "browser",
  });
  const source = await built.outputs[0]?.text();
  if (!built.success || !source)
    throw new Error(`Finance Back fixture did not bundle: ${built.logs}`);
  const css = stylesheets(
    ["tokens", "base", "typography", "controls", "surfaces"],
    ["finance"],
  );
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions());
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 600 });
    // Back and Forward need a real origin's history.
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      void request.respond({
        contentType: "text/html",
        body: `<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div></body></html>`,
      });
    });
    await page.goto("https://finance.test/finance", {
      waitUntil: "domcontentloaded",
    });
    await page.evaluate(async (code) => {
      const url = URL.createObjectURL(
        new Blob([code], { type: "text/javascript" }),
      );
      const { mount } = await import(url);
      URL.revokeObjectURL(url);
      mount(document.getElementById("root"));
    }, source);
    const rowsShown = (count: number) =>
      page.waitForFunction(
        (count) =>
          document.querySelectorAll(".financeTransaction").length === count,
        { timeout: 10_000 },
        count,
      );
    // Scrolling to the end shows Finance's second page of rows.
    await rowsShown(250);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await rowsShown(500);
    await page.evaluate(() =>
      window.scrollTo(0, document.body.scrollHeight * 0.75),
    );
    const left = await page.evaluate(() => window.scrollY);
    expect(left).toBeGreaterThan(10_000);

    await page.evaluate(() => {
      const onScreen = [
        ...document.querySelectorAll<HTMLAnchorElement>(
          "a.financeTransactionName",
        ),
      ].find((link) => {
        const { bottom, top } = link.getBoundingClientRect();
        return top >= 0 && bottom <= innerHeight;
      });
      onScreen?.click();
    });
    await page.waitForSelector(".record", { timeout: 5_000 });
    // The record page is too short to scroll.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    const returned = async () => {
      await page.waitForFunction(
        () =>
          location.pathname === "/finance" &&
          !document.querySelector(".record"),
        { timeout: 5_000 },
      );
      return page.evaluate(() => ({
        rows: document.querySelectorAll(".financeTransaction").length,
        top: window.scrollY,
      }));
    };
    await page.evaluate(() => history.back());
    expect(await returned()).toEqual({ rows: 500, top: left });

    // Forward to the record, then Back to Finance again.
    await page.evaluate(() => history.forward());
    await page.waitForSelector(".record", { timeout: 5_000 });
    await page.evaluate(() => history.back());
    expect(await returned()).toEqual({ rows: 500, top: left });
  } finally {
    await closeChrome(browser);
  }
}, 30_000);
