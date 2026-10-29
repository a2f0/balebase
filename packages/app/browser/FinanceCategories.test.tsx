import { expect, it } from "bun:test";
import { type Browser, launch } from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";
import { FinanceCategories } from "../src/finance/FinanceCategories";
import { stylesheets } from "./stylesheets";

it("opens a category from anywhere on its row except its own buttons", async () => {
  const markup = renderToStaticMarkup(
    <FinanceCategories
      categories={[
        { id: "meals", name: "Meals", slug: "meals", transactionCount: 2 },
        { id: "travel", name: "Travel", slug: "travel", transactionCount: 0 },
      ]}
      onChanged={async () => undefined}
      onShowTransactions={() => undefined}
    />,
  );
  const css = stylesheets(["tokens", "base", "controls", "surfaces"]);
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions());
    const page = await browser.newPage();
    for (const width of [1200, 375]) {
      await page.setViewport({ width, height: 800 });
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body>${markup}</body></html>`,
      );
      const hits = await page.evaluate(() =>
        [...document.querySelectorAll(".rowInteractive")].map((row) => {
          const hit = (x: number, y: number) => {
            const element = document.elementFromPoint(x, y);
            return element?.closest(".rowTarget")
              ? "row"
              : (element?.closest("button")?.textContent ?? "nothing");
          };
          const center = (selector: string) => {
            const element = row.querySelector(selector);
            if (!element) throw new Error(`Missing ${selector}`);
            const bounds = element.getBoundingClientRect();
            return hit(
              bounds.left + bounds.width / 2,
              bounds.top + bounds.height / 2,
            );
          };
          const bounds = row.getBoundingClientRect();
          const actions = row
            .querySelector(".rowActions")
            ?.getBoundingClientRect();
          if (!actions) throw new Error("Missing row actions");
          const [rename, remove] = [
            ...row.querySelectorAll(".rowActions button"),
          ].map((button) => button.getBoundingClientRect());
          if (!rename || !remove) throw new Error("Missing row buttons");
          return {
            betweenActions: hit(
              (rename.right + remove.left) / 2,
              rename.top + rename.height / 2,
            ),
            beforeActions: hit(
              actions.left - 4,
              actions.top + actions.height / 2,
            ),
            corner: hit(bounds.left + 4, bounds.top + 4),
            count: center(".rowMeta"),
            delete: center(".rowActions button:last-child"),
            rename: center(".rowActions button:first-child"),
          };
        }),
      );
      expect(hits).toEqual(
        Array(2).fill({
          beforeActions: "row",
          betweenActions: "row",
          corner: "row",
          count: "row",
          delete: "Delete",
          rename: "Rename",
        }),
      );
    }
  } finally {
    await closeChrome(browser);
  }
}, 30_000);
