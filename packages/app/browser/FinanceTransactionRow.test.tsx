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

it("keeps a transaction's in-page name button aligned and usable on a phone", async () => {
  const markup = renderToStaticMarkup(
    <div className="card financeListCard">
      <div className="cardFlush">
        <ul className="rowList financeTransactions">
          <FinanceTransactionRow
            busy={false}
            categories={[]}
            onAnnotate={async () => undefined}
            onCategorize={async () => undefined}
            onNavigate={() => undefined}
            onOpen={() => undefined}
            onSelectAnnotation={() => undefined}
            selectedTransactionId={undefined}
            transaction={transaction}
          />
        </ul>
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
      const result = await page.evaluate(() => {
        const name = document.querySelector<HTMLButtonElement>(
          "button.financeTransactionName",
        );
        const menu = document.querySelector(
          ".financeTransactionActions button",
        );
        if (!name || !menu) throw new Error("Missing transaction controls");
        const text = document.createRange();
        text.selectNodeContents(name);
        const bounds = name.getBoundingClientRect();
        const menuBounds = menu.getBoundingClientRect();
        return {
          overflows: document.documentElement.scrollWidth > innerWidth,
          startVisible: (text.getClientRects()[0]?.left ?? 0) >= bounds.left,
          ellipsis: getComputedStyle(name).textOverflow,
          nameClickable:
            document.elementFromPoint(
              bounds.left + bounds.width / 2,
              bounds.top + bounds.height / 2,
            ) === name,
          menuClickable:
            document
              .elementFromPoint(
                menuBounds.left + menuBounds.width / 2,
                menuBounds.top + menuBounds.height / 2,
              )
              ?.closest("button") === menu,
        };
      });
      expect(result).toEqual({
        overflows: false,
        startVisible: true,
        ellipsis: "ellipsis",
        nameClickable: true,
        menuClickable: true,
      });
    }
  } finally {
    await closeChrome(browser);
  }
}, 60_000);
