import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, launch } from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";
import { FinanceCategories } from "../src/FinanceCategories";

const { CHROME_PATH } = process.env;
const chrome =
  CHROME_PATH ||
  Bun.which("google-chrome") ||
  Bun.which("chromium") ||
  (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : null);

it("opens a category from anywhere on its row except its own buttons", async () => {
  if (!chrome)
    throw new Error("Chrome is required for the category row layout check.");
  const markup = renderToStaticMarkup(
    <FinanceCategories
      categories={[
        { id: "meals", name: "Meals", transactionCount: 2 },
        { id: "travel", name: "Travel", transactionCount: 0 },
      ]}
      onChanged={async () => undefined}
      onShowTransactions={() => undefined}
    />,
  );
  const styleRoot = fileURLToPath(
    new URL("../../ui/src/styles/", import.meta.url),
  );
  const css = ["tokens", "base", "controls", "surfaces"]
    .map((name) => readFileSync(join(styleRoot, `${name}.css`), "utf8"))
    .join("\n");
  const profile = mkdtempSync(join(tmpdir(), "finance-category-rows-"));
  let browser: Browser | undefined;
  try {
    browser = await launch({
      executablePath: chrome,
      headless: true,
      pipe: true,
      userDataDir: profile,
      timeout: 10_000,
      protocolTimeout: 10_000,
      // Hosted Ubuntu runners restrict Chrome's sandbox. This browser only
      // opens the generated fixture in a disposable profile.
      args: ["--no-sandbox", "--password-store=basic", "--use-mock-keychain"],
    });
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
    await browser?.close();
    rmSync(profile, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}, 30_000);
