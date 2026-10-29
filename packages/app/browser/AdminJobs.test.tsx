import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { type Browser, launch } from "puppeteer-core";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";
import { stylesheets } from "./stylesheets";

it("keeps long job descriptions beside actions and expands run details in place", async () => {
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
  const css = stylesheets(
    ["tokens", "base", "typography", "controls", "surfaces"],
    ["admin"],
  );
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions());
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
        const availableJobs = [
          ...document.querySelectorAll(".pageSection"),
        ].find(
          (section) =>
            section.querySelector("h2")?.textContent === "Available jobs",
        );
        if (!availableJobs) throw new Error("Missing available jobs section.");
        const rows = [...availableJobs.querySelectorAll(".adminJobRow")];
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
    await closeChrome(browser);
  }
}, 30_000);
