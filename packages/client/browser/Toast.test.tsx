import { expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, launch } from "puppeteer-core";

const harness = `
import { Toast, ToastProvider } from "@balebase/ui/react";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState(false);
  return (
    <ToastProvider>
      <main id="content" style={{ transform: "translateZ(0)", overflow: "hidden", height: 300 }}>
        <p>Page content stays in place.</p>
        <button id="notify" onClick={() => { setSuccess(true); setError(true); }}>Show notifications</button>
        {success && <Toast tone="success" actions={<button id="dismiss" onClick={() => setSuccess(false)}>Dismiss</button>}>Email address copied.</Toast>}
        {error && <Toast tone="danger">A separate upload failed. Please try again.</Toast>}
      </main>
      <div style={{ height: 2000 }} />
    </ToastProvider>
  );
}
createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
`;

it("stacks feedback at the viewport bottom without shifting or clipping page content", async () => {
  const { CHROME_PATH } = process.env;
  const chrome =
    CHROME_PATH ||
    Bun.which("google-chrome") ||
    Bun.which("chromium") ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chrome))
    throw new Error("Chrome is required for toast layout.");
  const fixture = mkdtempSync(
    join(fileURLToPath(new URL(".", import.meta.url)), ".toast-"),
  );
  const profile = mkdtempSync(join(tmpdir(), "toast-layout-"));
  let browser: Browser | undefined;
  try {
    const entry = join(fixture, "entry.tsx");
    writeFileSync(entry, harness);
    const bundle = await Bun.build({
      define: { "process.env.NODE_ENV": '"production"' },
      entrypoints: [entry],
      target: "browser",
    });
    if (!bundle.success)
      throw new Error(
        `Toast fixture did not bundle: ${bundle.logs.join("\n")}`,
      );
    const source = await bundle.outputs[0]?.text();
    if (!source) throw new Error("Toast fixture is empty.");
    const styleRoot = fileURLToPath(
      new URL("../../ui/src/styles/", import.meta.url),
    );
    const css = ["tokens", "base", "surfaces"]
      .map((name) => readFileSync(join(styleRoot, `${name}.css`), "utf8"))
      .join("\n");
    browser = await launch({
      executablePath: chrome,
      headless: true,
      pipe: true,
      userDataDir: profile,
      timeout: 10_000,
      protocolTimeout: 10_000,
      args: ["--no-sandbox", "--password-store=basic", "--use-mock-keychain"],
    });
    for (const width of [1200, 375]) {
      const page = await browser.newPage();
      await page.setViewport({ width, height: 800 });
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div></body></html>`,
      );
      await page.evaluate(async (code) => {
        const url = URL.createObjectURL(
          new Blob([code], { type: "text/javascript" }),
        );
        await import(url);
        URL.revokeObjectURL(url);
      }, source);
      await page.waitForSelector("#notify");
      const before = await page.evaluate(() => ({
        top: document.querySelector("#content")?.getBoundingClientRect().top,
        height: document.documentElement.scrollHeight,
      }));
      await page.click("#notify");
      await page.waitForSelector('.toastViewport [role="alert"]');
      const after = await page.evaluate(() => ({
        top: document.querySelector("#content")?.getBoundingClientRect().top,
        height: document.documentElement.scrollHeight,
      }));
      expect(after).toEqual(before);
      await page.evaluate(() => window.scrollTo(0, 600));
      const layout = await page.evaluate(() => {
        const region = document.querySelector(".toastViewport");
        const toasts = [...document.querySelectorAll(".toast")].map((toast) =>
          toast.getBoundingClientRect(),
        );
        const first = toasts[0];
        const last = toasts[1];
        return {
          outsidePage: region?.parentElement === document.body,
          scrolled: window.scrollY > 0,
          stacked: Boolean(first && last && first.bottom < last.top),
          bottom: last ? window.innerHeight - last.bottom : undefined,
          visible: toasts.every(
            (bounds) =>
              bounds.top >= 0 &&
              bounds.bottom <= innerHeight &&
              bounds.left >= 0 &&
              bounds.right <= innerWidth,
          ),
        };
      });
      expect(layout).toEqual({
        outsidePage: true,
        scrolled: true,
        stacked: true,
        bottom: 16,
        visible: true,
      });
      await page.click("#dismiss");
      await page.waitForFunction(
        () => document.querySelectorAll(".toast").length === 1,
      );
      expect(
        await page.$eval(".toast", (toast) => toast.textContent),
      ).toContain("A separate upload failed.");
      await page.close();
    }
  } finally {
    await browser?.close();
    rmSync(fixture, { recursive: true, force: true });
    rmSync(profile, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}, 30_000);
