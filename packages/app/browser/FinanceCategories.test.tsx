import { expect, it } from "bun:test";
import { type Browser, launch } from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";
import { FinanceCategories } from "../src/finance/FinanceCategories";
import { stylesheets } from "./stylesheets";

it("opens a category from anywhere on its row, total included, except its menu button", async () => {
  const markup = renderToStaticMarkup(
    <FinanceCategories
      categories={[
        {
          id: "meals",
          name: "Meals and entertainment with clients abroad",
          slug: "meals",
          transactionCount: 2,
          transactionCountsByYear: [
            {
              // Several currencies, which must not push the menu out.
              totals: [
                { currencyCode: "EUR", total: -1234567.89 },
                { currencyCode: "KWD", total: -1.235 },
                { currencyCode: "USD", total: -42.5 },
              ],
              transactionCount: 2,
              year: 2026,
            },
          ],
        },
        {
          id: "travel",
          name: "Travel",
          slug: "travel",
          transactionCount: 0,
          transactionCountsByYear: [],
        },
      ]}
      onChanged={async () => undefined}
      onRefused={async () => undefined}
      onShowTransactions={() => undefined}
      onYearChange={() => undefined}
      year={null}
    />,
  );
  const css = stylesheets(
    ["tokens", "base", "controls", "surfaces"],
    ["finance"],
  );
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions());
    const page = await browser.newPage();
    for (const width of [1200, 375]) {
      await page.setViewport({ width, height: 1200 });
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body>${markup}</body></html>`,
      );
      const hits = await page.evaluate(() =>
        [...document.querySelectorAll(".rowInteractive")].map((row) => {
          const hit = (x: number, y: number) => {
            const element = document.elementFromPoint(x, y);
            return element?.closest(".rowTarget")
              ? "row"
              : (element?.closest("button")?.getAttribute("aria-label") ??
                  element?.closest("button")?.textContent ??
                  "nothing");
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
          const amount = row.querySelector(".financeAmount");
          const amountBounds = amount?.getBoundingClientRect();
          const title = row.querySelector(".rowTitle")?.getBoundingClientRect();
          return {
            // The total sits on the name's line, clear of the name and menu.
            amount: amount ? center(".financeAmount") : null,
            // ...and leaves the name room to be read.
            amountInLine:
              row.scrollWidth <= row.clientWidth &&
              (title?.width ?? 0) >=
                Math.min(
                  96,
                  row.querySelector(".rowTitle")?.scrollWidth ?? 0,
                ) &&
              actions.right <= bounds.right &&
              (!amountBounds ||
                (title !== undefined &&
                  amountBounds.left >= title.right &&
                  amountBounds.right <= actions.left &&
                  amountBounds.top < bounds.top + bounds.height / 2 &&
                  amountBounds.bottom > bounds.top + bounds.height / 2)),
            beforeActions: hit(
              actions.left - 4,
              actions.top + actions.height / 2,
            ),
            corner: hit(bounds.left + 4, bounds.top + 4),
            count: center(".rowMeta"),
            menu: center(".rowActions button"),
            rowButtons: row.querySelectorAll(".rowActions button").length,
          };
        }),
      );
      expect(hits).toEqual([
        {
          amount: "row",
          amountInLine: true,
          beforeActions: "row",
          corner: "row",
          count: "row",
          menu: "Actions for Meals and entertainment with clients abroad",
          rowButtons: 1,
        },
        {
          amount: null,
          amountInLine: true,
          beforeActions: "row",
          corner: "row",
          count: "row",
          menu: "Actions for Travel",
          rowButtons: 1,
        },
      ]);
    }
  } finally {
    await closeChrome(browser);
  }
}, 30_000);
