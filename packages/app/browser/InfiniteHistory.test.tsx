import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Browser, launch } from "puppeteer-core";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";

it("appends job and transaction pages on desktop/mobile scroll and fills a short viewport", async () => {
  const built = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL("./historyScrollFixture.tsx", import.meta.url)),
    ],
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    target: "browser",
  });
  const source = await built.outputs[0]?.text();
  if (!built.success || !source)
    throw new Error("Could not bundle infinite history fixture");
  const css = [
    ...["tokens", "base", "typography", "controls", "surfaces"].map(
      (name) => new URL(`../../ui/src/styles/${name}.css`, import.meta.url),
    ),
    ...["admin", "finance"].map(
      (name) => new URL(`../src/styles/${name}.css`, import.meta.url),
    ),
  ]
    .map((url) => readFileSync(url, "utf8"))
    .join("\n");
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions());
    for (const mode of ["jobs", "finance"] as const) {
      for (const [width, pageSize] of [
        [1200, 20],
        [375, 20],
        [1200, 1],
      ] as const) {
        const page = await browser.newPage();
        await page.setViewport({
          width,
          height: 600,
          isMobile: width === 375,
          hasTouch: width === 375,
        });
        await page.setContent(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
        );
        await page.evaluate(
          async ({ source, mode, pageSize }) => {
            const url = URL.createObjectURL(
              new Blob([source], { type: "text/javascript" }),
            );
            const { mount } = await import(url);
            URL.revokeObjectURL(url);
            mount(document.getElementById("root"), mode, pageSize);
          },
          { source, mode, pageSize },
        );
        const selector =
          mode === "jobs" ? ".adminJobHistoryItem" : ".financeTransaction";
        if (pageSize > 1) {
          for (const count of [20, 40]) {
            await page.waitForFunction(
              (selector, count) =>
                document.querySelectorAll(selector).length === count,
              {},
              selector,
              count,
            );
            await page.evaluate(() =>
              window.scrollTo(0, document.body.scrollHeight),
            );
          }
        }
        await page.waitForFunction(
          (selector, count) =>
            document.querySelectorAll(selector).length === count,
          {},
          selector,
          pageSize * 3,
        );
        expect(
          await page.evaluate(() =>
            [...document.querySelectorAll("button")].some((button) =>
              ["Older runs", "Load more transactions"].includes(
                button.textContent?.trim() ?? "",
              ),
            ),
          ),
        ).toBe(false);
        await page.close();
      }
    }
  } finally {
    await closeChrome(browser);
  }
}, 30_000);
