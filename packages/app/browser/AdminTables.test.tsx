import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { type Browser, launch } from "puppeteer-core";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";
import { stylesheets } from "./stylesheets";

// Wide tables above the 64rem stacking width; labelled cards below it.
const widths = [
  { stacked: false, width: 1440 },
  { stacked: false, width: 1200 },
  { stacked: true, width: 1030 },
  { stacked: true, width: 760 },
  { stacked: true, width: 390 },
];

it("keeps root admin tables and their row menus on screen without sideways scrolling", async () => {
  const bundle = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL("./adminTablesFixture.tsx", import.meta.url)),
    ],
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    target: "browser",
  });
  const source = await bundle.outputs[0]?.text();
  if (!bundle.success || !source)
    throw new Error(`Admin fixture did not bundle: ${bundle.logs.join("\n")}`);
  const css = stylesheets(
    ["tokens", "base", "typography", "controls", "surfaces", "contextMenu"],
    ["admin"],
  );
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions());
    for (const table of ["users", "organizations"]) {
      for (const { stacked, width } of widths) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 900 });
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div></body></html>`,
        );
        await page.evaluate(
          async (code, name) => {
            const url = URL.createObjectURL(
              new Blob([code], { type: "text/javascript" }),
            );
            const { mount } = await import(url);
            URL.revokeObjectURL(url);
            mount(document.getElementById("root"), name);
          },
          source,
          table,
        );
        await page.waitForSelector("tbody tr:nth-child(4)");
        const layout = await page.evaluate(() => {
          const wrap = document.querySelector<HTMLElement>(".tableWrap");
          const header = document.querySelector("thead");
          if (!wrap || !header) throw new Error("Missing table.");
          const edge = wrap.getBoundingClientRect();
          return {
            headerHidden: header.getBoundingClientRect().height <= 1,
            // Anything past its own cell overlaps a neighbour or the edge.
            overflowing: [...wrap.querySelectorAll("tbody td")].flatMap(
              (cell) => {
                const bounds = cell.getBoundingClientRect();
                return [...cell.querySelectorAll("*")]
                  .filter((element) => {
                    const inner = element.getBoundingClientRect();
                    return (
                      inner.right > Math.min(bounds.right, edge.right) + 0.5 ||
                      inner.left < bounds.left - 0.5
                    );
                  })
                  .map((element) => element.className || element.tagName);
              },
            ),
            pageScrolls:
              document.documentElement.scrollWidth > window.innerWidth,
            tableScrolls: wrap.scrollWidth > wrap.clientWidth,
            visibleButtons: [
              ...wrap.querySelectorAll('[aria-haspopup="menu"]'),
            ].filter((button) => {
              const bounds = button.getBoundingClientRect();
              return bounds.left >= edge.left && bounds.right <= edge.right;
            }).length,
          };
        });
        expect({ table, width, ...layout }).toEqual({
          table,
          width,
          headerHidden: stacked,
          overflowing: [],
          pageScrolls: false,
          tableScrolls: false,
          visibleButtons: 4,
        });

        // Right-clicking a row opens the same actions as its menu button.
        await page.click("tbody tr:nth-child(2) td:nth-child(2)", {
          button: "right",
        });
        const items = await page.$$eval('[role="menuitem"]', (elements) =>
          elements.map((element) => element.textContent),
        );
        expect(items[0]).toBe(
          table === "users" ? "Cancel deletion" : "Restore",
        );
        await page.close();
      }
    }
  } finally {
    await closeChrome(browser);
  }
});
