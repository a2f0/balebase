import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, launch } from "puppeteer-core";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";

// Three 400px entries in a 600px viewport. The first is lifted and held at the
// bottom edge, where the page scrolls 16px a frame. Its transform grows the
// page as it follows the pointer, so only the limit taken when the drag began
// keeps the scroll from running on into empty space.
const harness = (hook: string) => `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { moveEntry, useReorderDrag } from ${JSON.stringify(hook)};

function App() {
  const [entries, setEntries] = useState(["a", "b", "c"]);
  const drag = useReorderDrag(entries, (from, to) =>
    setEntries(moveEntry(entries, from, to)),
  );
  return (
    <div>
      {entries.map((entry, index) => {
        const state = drag.entryState(index);
        return (
          <div
            data-reorder-item=""
            key={entry}
            style={{
              height: 400,
              position: "relative",
              transform: state.dragging
                ? \`translateY(\${state.offset}px)\`
                : undefined,
            }}
          >
            <button
              {...drag.handleProps(index)}
              id={\`handle-\${entry}\`}
              style={{ touchAction: "none" }}
              type="button"
            >
              {entry}
            </button>
          </div>
        );
      })}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
`;

it("never scrolls past the page while a lifted entry rests at the edge", async () => {
  // Inside the package, so the fixture resolves React like the app does.
  const fixture = mkdtempSync(
    join(fileURLToPath(new URL(".", import.meta.url)), ".reorder-"),
  );
  let browser: Browser | undefined;
  try {
    const entry = join(fixture, "entry.tsx");
    writeFileSync(
      entry,
      harness(
        fileURLToPath(new URL("../src/useReorderDrag.ts", import.meta.url)),
      ),
    );
    const bundle = await Bun.build({
      define: { "process.env.NODE_ENV": '"production"' },
      entrypoints: [entry],
      target: "browser",
    });
    if (!bundle.success)
      throw new Error(
        `Reorder fixture did not bundle: ${bundle.logs.join("\n")}`,
      );
    const source = await bundle.outputs[0]?.text();
    if (!source) throw new Error("Reorder fixture is empty.");

    browser = await launch(chromeLaunchOptions({ protocolTimeout: 20_000 }));
    const page = await browser.newPage();
    await page.setViewport({ height: 600, width: 800 });
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      void request.respond({
        body: '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>',
        contentType: "text/html",
      });
    });
    await page.goto("https://reorder.test/", { waitUntil: "domcontentloaded" });
    await page.evaluate(async (code) => {
      const url = URL.createObjectURL(
        new Blob([code], { type: "text/javascript" }),
      );
      await import(url);
      URL.revokeObjectURL(url);
    }, source);
    const handle = await page.waitForSelector("#handle-a");
    const bounds = await handle?.boundingBox();
    if (!bounds) throw new Error("The first handle has no box.");
    const limit = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );

    await page.mouse.move(bounds.x + 4, bounds.y + 4);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 4, 595, { steps: 5 });
    // Count frames, not seconds: a busy host draws as few as ten frames a
    // second. Wait until the scroll has held still for ten frames, or until
    // it passes the limit, as it would every frame without the clamp.
    const scrolled = await page.evaluate(
      (end) =>
        new Promise<number>((resolve) => {
          let last = window.scrollY;
          let still = 0;
          const frame = () => {
            const y = window.scrollY;
            still = y === last ? still + 1 : 0;
            last = y;
            if (y > end || still === 10) resolve(y);
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        }),
      limit,
    );
    await page.mouse.up();

    expect(limit).toBe(600);
    expect(scrolled).toBe(limit);
  } finally {
    await closeChrome(browser);
    rmSync(fixture, { force: true, recursive: true });
  }
}, 30_000);
