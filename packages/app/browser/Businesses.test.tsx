import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Business } from "@balebase/validators/businesses";
import { type Browser, launch } from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";
import { BusinessListView } from "../src/Businesses";
import {
  type BusinessListState,
  businessListReducer,
  initialBusinessListState,
} from "../src/businessState";

const acme: Business = {
  city: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  duns: null,
  ein: null,
  id: "business-1",
  incorporationDate: null,
  name: "Acme, Inc.",
  state: null,
  streetAddress: null,
  updatedAt: "2026-09-01T00:00:00.000Z",
  zip: null,
};

function renderState(state: BusinessListState, copied = false) {
  const noop = () => {};
  return renderToStaticMarkup(
    <BusinessListView
      {...state}
      copyNotice={
        copied ? { message: "EIN copied.", tone: "success" } : undefined
      }
      onAddingChange={noop}
      onCopy={noop}
      onCreated={noop}
      onDeleted={noop}
      onError={noop}
      onNavigate={noop}
      onUpdated={noop}
    />,
  );
}

it("business notification layout stays at the bottom without moving content", async () => {
  const state = businessListReducer(initialBusinessListState, {
    type: "loaded",
    data: { businesses: [{ ...acme, ein: "123456789" }], canManage: true },
  });
  const before = renderState(state);
  const after = renderState(state, true);
  const styleRoot = fileURLToPath(
    new URL("../../ui/src/styles/", import.meta.url),
  );
  const css = ["tokens", "base", "surfaces"]
    .map((name) => readFileSync(join(styleRoot, `${name}.css`), "utf8"))
    .join("\n");
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions());
    const page = await browser.newPage();
    for (const width of [1200, 375]) {
      await page.setViewport({ width, height: 800 });
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body></body></html>`,
      );
      const result = await page.evaluate(
        ({ before, after }) => {
          const bounds = (selector: string) => {
            const element = document.querySelector(selector);
            if (!element)
              throw new Error(`Missing layout element: ${selector}`);
            return element.getBoundingClientRect();
          };
          const filler = '<div style="height:2000px"></div>';
          document.body.innerHTML = before + filler;
          window.scrollTo(0, 0);
          const listTop = bounds(".rowList").top;
          const pageHeight = bounds(".pageBody").height;
          document.body.innerHTML = after + filler;
          const initialToast = bounds('[role="status"]');
          const listDidNotMove = listTop === bounds(".rowList").top;
          const pageHeightUnchanged = pageHeight === bounds(".pageBody").height;
          window.scrollTo(0, 600);
          const scrolledToast = bounds('[role="status"]');
          return {
            listDidNotMove,
            pageHeightUnchanged,
            pinnedAfterScroll:
              initialToast.top === scrolledToast.top &&
              Math.abs(window.innerHeight - scrolledToast.bottom - 16) < 1,
            visibleAfterScroll:
              scrolledToast.top >= 0 &&
              scrolledToast.bottom <= window.innerHeight &&
              scrolledToast.left >= 0 &&
              scrolledToast.right <= window.innerWidth,
            scrolled: window.scrollY > 0,
            viewportWidth: window.innerWidth,
          };
        },
        { before, after },
      );
      expect(result).toEqual({
        listDidNotMove: true,
        pageHeightUnchanged: true,
        pinnedAfterScroll: true,
        visibleAfterScroll: true,
        scrolled: true,
        viewportWidth: width,
      });
    }
  } finally {
    await closeChrome(browser);
  }
}, 30_000);
