import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, launch } from "puppeteer-core";

it("keeps long job descriptions beside actions and expands run details in place", async () => {
  const { CHROME_PATH } = process.env;
  const chrome =
    CHROME_PATH ||
    Bun.which("google-chrome") ||
    Bun.which("chromium") ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chrome))
    throw new Error("Chrome is required for the jobs layout check.");
  const bundle = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL("./adminJobsFixture.tsx", import.meta.url)),
    ],
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    target: "browser",
  });
  const source = await bundle.outputs[0]?.text();
  if (!bundle.success || !source)
    throw new Error(`Jobs fixture did not bundle: ${bundle.logs.join("\n")}`);
  const css = [
    ...["tokens", "base", "typography", "controls", "surfaces"].map(
      (name) => new URL(`../../ui/src/styles/${name}.css`, import.meta.url),
    ),
    new URL("../src/styles/admin.css", import.meta.url),
  ]
    .map((url) => readFileSync(fileURLToPath(url), "utf8"))
    .join("\n");
  const profile = mkdtempSync(join(tmpdir(), "job-row-layout-"));
  let browser: Browser | undefined;
  try {
    browser = await launch({
      executablePath: chrome,
      headless: true,
      pipe: true,
      userDataDir: profile,
      timeout: 10_000,
      protocolTimeout: 10_000,
      args: ["--no-sandbox", "--password-store=basic", "--use-mock-keychain"],
    });
    for (const width of [1500, 375]) {
      const page = await browser.newPage();
      await page.setViewport({
        width,
        height: 1000,
        isMobile: width === 375,
        hasTouch: width === 375,
      });
      await page.setContent(
        `<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
      );
      await page.evaluate(async (code) => {
        const url = URL.createObjectURL(
          new Blob([code], { type: "text/javascript" }),
        );
        const { mount } = await import(url);
        URL.revokeObjectURL(url);
        mount(document.getElementById("root"));
      }, source);
      await page.waitForSelector(".adminJobHistoryItem");
      const layout = await page.evaluate(() => {
        const rows = [
          ...document.querySelectorAll(
            ".pageSection:first-of-type .adminJobRow",
          ),
        ];
        return rows.map((row) => {
          const text = row
            .querySelector(".adminJobSummary")
            ?.getBoundingClientRect();
          const button = row.querySelector("button")?.getBoundingClientRect();
          if (!text || !button)
            throw new Error("Missing job summary or action.");
          return {
            beside: button.left >= text.right,
            aligned: Math.abs(button.top - text.top) < 1,
            right: button.right,
          };
        });
      });
      expect(layout).toHaveLength(2);
      expect(layout.every((row) => row.beside && row.aligned)).toBe(true);
      expect(layout[0]?.right).toBe(layout[1]?.right);
      await page.click(".adminJobHistoryItem button");
      await page.waitForSelector(".adminJobRunDetails pre");
      const expanded = await page.evaluate(() => {
        const items = document.querySelectorAll(".adminJobHistoryItem");
        const first = items[0];
        const second = items[1];
        if (!first || !second) throw new Error("Missing history rows.");
        const details = first.querySelector(".adminJobRunDetails");
        const button = first.querySelector("button");
        const panel = document.getElementById(
          button?.getAttribute("aria-controls") ?? "",
        );
        return {
          inline:
            details?.parentElement === panel && panel?.parentElement === first,
          expanded: button?.getAttribute("aria-expanded"),
          nextRowFollowsDetails: Boolean(
            details &&
              second.getBoundingClientRect().top >=
                details.getBoundingClientRect().bottom,
          ),
          noOverflow: document.documentElement.scrollWidth <= innerWidth,
        };
      });
      expect(expanded).toEqual({
        inline: true,
        expanded: "true",
        nextRowFollowsDetails: true,
        noOverflow: true,
      });
      await page.click(".adminJobHistoryItem button");
      await page.waitForFunction(
        () => !document.querySelector(".adminJobRunDetails"),
      );
      await page.close();
    }
  } finally {
    await browser?.close();
    rmSync(profile, { recursive: true, force: true });
  }
}, 30_000);
