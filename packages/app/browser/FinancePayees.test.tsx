import { expect, it } from "bun:test";
import { type Browser, launch } from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";
import { FinancePayeeList } from "../src/finance/FinancePayeeList";
import { stylesheets } from "./stylesheets";

const payee = (name: string, pending = 0) => ({
  count: 3,
  currencyCode: "USD",
  latestDate: "2026-11-03",
  name,
  pending,
  total: -42.5,
});

it("opens a payee from anywhere on its row, without overflowing a phone", async () => {
  const markup = renderToStaticMarkup(
    <div className="card financeListCard">
      <div className="cardFlush">
        <FinancePayeeList
          onSelect={() => undefined}
          payees={[payee("Shell", 1), payee(`Long${"Payee".repeat(30)}`)]}
        />
      </div>
    </div>,
  );
  const css = stylesheets(
    ["tokens", "base", "typography", "controls", "surfaces"],
    ["finance"],
  );
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions());
    const page = await browser.newPage();
    for (const width of [1200, 390]) {
      await page.setViewport({ width, height: 800 });
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body>${markup}</body></html>`,
      );
      const result = await page.evaluate(() => ({
        overflows: document.documentElement.scrollWidth > innerWidth,
        rows: [...document.querySelectorAll(".financePayee")].map((row) => {
          const target = row.querySelector(".rowTarget");
          const hit = (element: Element | null) => {
            if (!element) return "missing";
            const bounds = element.getBoundingClientRect();
            const found = document.elementFromPoint(
              bounds.left + bounds.width / 2,
              bounds.top + bounds.height / 2,
            );
            return found === target ? "name" : (found?.className ?? "nothing");
          };
          const bounds = row.getBoundingClientRect();
          // The row's far edge, clear of a last row's rounded corners.
          const edge = document.elementFromPoint(
            bounds.right - 2,
            bounds.top + bounds.height / 2,
          );
          // A long name keeps its first letters and ends in an ellipsis.
          if (!(target instanceof HTMLElement)) throw new Error("No target");
          const text = document.createRange();
          text.selectNodeContents(target);
          const textLeft = text.getClientRects()[0]?.left ?? Number.NaN;
          const name =
            Math.abs(textLeft - target.getBoundingClientRect().left) > 1
              ? "start cut off"
              : target.scrollWidth > target.clientWidth
                ? getComputedStyle(target).textOverflow
                : "fits";
          return {
            amount: hit(row.querySelector(".financeAmount")),
            name,
            badge: row.querySelector(".badge")
              ? hit(row.querySelector(".badge"))
              : "none",
            edge: edge === target ? "name" : "elsewhere",
            meta: hit(row.querySelector(".rowMeta")),
          };
        }),
      }));
      expect(result).toEqual({
        overflows: false,
        rows: [
          {
            amount: "name",
            badge: "name",
            edge: "name",
            meta: "name",
            name: "fits",
          },
          {
            amount: "name",
            badge: "none",
            edge: "name",
            meta: "name",
            name: "ellipsis",
          },
        ],
      });
    }
  } finally {
    await closeChrome(browser);
  }
}, 60_000);
