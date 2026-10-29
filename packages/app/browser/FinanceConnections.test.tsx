import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FinanceConnection } from "@balebase/validators/finance";
import { type Browser, launch } from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";
import { FinanceConnections } from "../src/FinanceAccounts";

const connection = (
  id: string,
  institutionName: string,
  status: string,
): FinanceConnection => ({
  accountCount: 2,
  dailySync: false,
  syncStatus: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  errorCode: null,
  id,
  institutionId: null,
  institutionName,
  lastSyncedAt: "2026-10-18T12:00:00.000Z",
  status,
});

it("opens a connection from anywhere on its row except its own buttons", async () => {
  const markup = renderToStaticMarkup(
    <FinanceConnections
      busy={false}
      connections={[
        connection("item-1", "First Platypus Bank", "active"),
        connection("item-2", "Tattersall Federal Credit Union", "disconnected"),
      ]}
      loadError={undefined}
      onConnect={async () => undefined}
      onDeleteData={async () => undefined}
      onDisconnect={async () => undefined}
      onNavigate={() => undefined}
      onReload={async () => undefined}
      onSync={async () => undefined}
    />,
  );
  const styleRoot = fileURLToPath(
    new URL("../../ui/src/styles/", import.meta.url),
  );
  const css = [
    ...["tokens", "base", "controls", "surfaces"].map((name) =>
      join(styleRoot, `${name}.css`),
    ),
    fileURLToPath(new URL("../src/styles/finance.css", import.meta.url)),
  ]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
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
          const [first, second] = [
            ...row.querySelectorAll(".rowActions button"),
          ].map((button) => button.getBoundingClientRect());
          if (!first || !second) throw new Error("Missing row buttons");
          return {
            betweenActions: hit(
              (first.right + second.left) / 2,
              first.top + first.height / 2,
            ),
            corner: hit(bounds.left + 4, bounds.top + 4),
            first: center(".rowActions button:first-child"),
            mark: center(".financeInstitutionMark"),
            meta: center(".rowMeta"),
            second: center(".rowActions button:last-child"),
            status: center(".financeConnectionStatus"),
          };
        }),
      );
      const row = { betweenActions: "row", corner: "row", mark: "row" };
      expect(hits).toEqual([
        {
          ...row,
          first: "Sync now",
          meta: "row",
          second: "Disconnect",
          status: "row",
        },
        {
          ...row,
          first: "Reconnect",
          meta: "row",
          second: "Delete data",
          status: "row",
        },
      ]);
    }
  } finally {
    await closeChrome(browser);
  }
}, 30_000);
