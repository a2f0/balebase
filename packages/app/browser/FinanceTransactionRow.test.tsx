import { expect, it } from "bun:test";
import type { FinanceTransaction } from "@balebase/validators/finance";
import { type Browser, launch } from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";
import { FinanceTransactionRow } from "../src/finance/FinanceTransactionHistory";
import { stylesheets } from "./stylesheets";

const transaction: FinanceTransaction = {
  accountId: "checking",
  accountName: "Checking",
  amount: 10,
  annotation: { labels: [], note: "", reviewed: false },
  authorizedDate: null,
  categoryDetailed: null,
  categoryPrimary: null,
  currencyCode: "USD",
  expenseCategoryId: null,
  id: "transaction",
  linkedEmails: [],
  merchantName: null,
  name: `Long${"Payee".repeat(30)}`,
  paymentChannel: null,
  pending: false,
  transactionDate: "2026-11-01",
};

function transactionMarkup(name = transaction.name, inPage = true) {
  return renderToStaticMarkup(
    <div className="card financeListCard">
      <div className="cardFlush">
        <ul className="rowList financeTransactions">
          <FinanceTransactionRow
            busy={false}
            categories={[]}
            onAnnotate={async () => undefined}
            onCategorize={async () => undefined}
            onNavigate={() => undefined}
            onOpen={inPage ? () => undefined : undefined}
            onSelectAnnotation={() => undefined}
            selectedTransactionId={undefined}
            transaction={{ ...transaction, name }}
          />
        </ul>
      </div>
    </div>,
  );
}

const css = stylesheets(
  ["tokens", "base", "typography", "controls", "surfaces"],
  ["finance"],
);

it("keeps a transaction's in-page name button aligned and usable on a phone", async () => {
  const markup = transactionMarkup();
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions());
    const page = await browser.newPage();
    for (const width of [1200, 390]) {
      const touch = width === 390;
      await page.setViewport({
        width,
        height: 800,
        isMobile: touch,
        hasTouch: touch,
      });
      await page.setContent(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${markup}</body></html>`,
      );
      const result = await page.evaluate(() => {
        const name = document.querySelector<HTMLButtonElement>(
          "button.financeTransactionName",
        );
        const menu = document.querySelector(
          ".financeTransactionActions button",
        );
        const row = name?.closest(".financeTransaction");
        const amount = row?.querySelector(".financeAmount");
        if (!name || !menu || !row || !amount) {
          throw new Error("Missing transaction controls");
        }
        const text = document.createRange();
        text.selectNodeContents(name);
        const bounds = name.getBoundingClientRect();
        const rowBounds = row.getBoundingClientRect();
        const menuBounds = menu.getBoundingClientRect();
        return {
          coarse: matchMedia("(pointer: coarse)").matches,
          viewportWidth: innerWidth,
          height: bounds.height,
          overflows: document.documentElement.scrollWidth > innerWidth,
          startVisible: (text.getClientRects()[0]?.left ?? 0) >= bounds.left,
          ellipsis: getComputedStyle(name).textOverflow,
          clipped:
            name.scrollWidth > name.clientWidth &&
            getComputedStyle(name).overflowX === "hidden",
          contained:
            bounds.left >= rowBounds.left &&
            bounds.right <= amount.getBoundingClientRect().left &&
            bounds.top >= rowBounds.top &&
            bounds.bottom <= rowBounds.bottom,
          nameClickable: [
            bounds.top + 1,
            bounds.top + bounds.height / 2,
            bounds.bottom - 1,
          ].every(
            (y) =>
              document.elementFromPoint(bounds.left + bounds.width / 2, y) ===
              name,
          ),
          menuClickable:
            document
              .elementFromPoint(
                menuBounds.left + menuBounds.width / 2,
                menuBounds.top + menuBounds.height / 2,
              )
              ?.closest("button") === menu,
        };
      });
      expect(result.coarse).toBe(touch);
      expect(result.viewportWidth).toBe(width);
      if (touch) expect(result.height).toBeGreaterThanOrEqual(40);
      expect(result).toMatchObject({
        overflows: false,
        startVisible: true,
        ellipsis: "ellipsis",
        clipped: true,
        contained: true,
        nameClickable: true,
        menuClickable: true,
      });
    }
  } finally {
    await closeChrome(browser);
  }
}, 60_000);

it("keeps multiword transaction names wrapping and selectable like links", async () => {
  const name =
    "Harborline Electric Commercial Electrical Supplies Warehouse Delivery";
  const markup = transactionMarkup(name) + transactionMarkup(name, false);
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions());
    const page = await browser.newPage();
    for (const width of [1200, 390]) {
      const touch = width === 390;
      await page.setViewport({
        width,
        height: 800,
        isMobile: touch,
        hasTouch: touch,
      });
      await page.setContent(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${markup}</body></html>`,
      );
      const [button, link] = await page.evaluate(() =>
        ["button", "a"].map((tag) => {
          const element = document.querySelector(
            `${tag}.financeTransactionName`,
          );
          if (!element) throw new Error(`Missing transaction ${tag}`);
          const style = getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          const lines = [...range.getClientRects()];
          return {
            lineCount: new Set(lines.map((line) => line.top)).size,
            lineHeight: style.lineHeight,
            whiteSpace: style.whiteSpace,
            selectable: style.userSelect !== "none",
            textFits: lines.every(
              (line) =>
                line.left >= bounds.left &&
                line.right <= bounds.right &&
                line.top >= bounds.top &&
                line.bottom <= bounds.bottom,
            ),
          };
        }),
      );
      expect(button).toMatchObject({
        lineCount: link?.lineCount,
        lineHeight: link?.lineHeight,
        whiteSpace: "normal",
        selectable: true,
        textFits: true,
      });
      if (touch) expect(button?.lineCount).toBeGreaterThan(1);
    }
  } finally {
    await closeChrome(browser);
  }
}, 60_000);
