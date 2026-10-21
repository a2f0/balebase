import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, launch } from "puppeteer-core";

const { CHROME_PATH } = process.env;
const chrome =
  CHROME_PATH ||
  Bun.which("google-chrome") ||
  Bun.which("chromium") ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

it("a narrow tab strip shows the current tab and keeps a strip the user scrolled", async () => {
  if (!existsSync(chrome))
    throw new Error("Chrome is required for the page tabs check.");
  const bundle = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL("./pageTabsFixture.tsx", import.meta.url)),
    ],
    define: { "process.env.NODE_ENV": '"production"' },
    target: "browser",
  });
  const source = await bundle.outputs[0]?.text();
  if (!bundle.success || !source)
    throw new Error(
      `Page tabs fixture did not bundle: ${bundle.logs.join("\n")}`,
    );
  const css = ["tokens", "base", "typography", "surfaces"]
    .map((name) =>
      readFileSync(
        fileURLToPath(
          new URL(`../../ui/src/styles/${name}.css`, import.meta.url),
        ),
        "utf8",
      ),
    )
    .join("\n");
  const profile = mkdtempSync(join(tmpdir(), "page-tabs-"));
  let browser: Browser | undefined;
  try {
    browser = await launch({
      executablePath: chrome,
      headless: true,
      pipe: true,
      userDataDir: profile,
      timeout: 10_000,
      protocolTimeout: 10_000,
      args: ["--no-sandbox", "--password-store=basic", "--use-mock-keychain"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 320, height: 640 });
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div></body></html>`,
    );
    const result = await page.evaluate(async (code) => {
      const url = URL.createObjectURL(
        new Blob([code], { type: "text/javascript" }),
      );
      const { mount } = await import(url);
      URL.revokeObjectURL(url);
      const render = mount(document.getElementById("root"));
      const strip = () => document.querySelector(".pageTabs") as HTMLElement;
      const currentInView = () => {
        const bounds = strip().getBoundingClientRect();
        const tab = strip()
          .querySelector('[aria-current="page"]')
          ?.getBoundingClientRect();
        return Boolean(
          tab && tab.left >= bounds.left - 1 && tab.right <= bounds.right + 1,
        );
      };
      render("API keys", "Organization");
      const lastTab = {
        inView: currentInView(),
        scrolled: strip().scrollLeft > 0,
      };
      strip().scrollLeft = 0;
      render("API keys", "Organization settings");
      const userScroll = strip().scrollLeft;
      render("General", "Organization settings");
      render("Access", "Organization settings");
      return {
        lastTab,
        userScroll,
        accessInView: currentInView(),
        overflows: strip().scrollWidth > strip().clientWidth,
      };
    }, source);
    expect(result).toEqual({
      lastTab: { inView: true, scrolled: true },
      userScroll: 0,
      accessInView: true,
      overflows: true,
    });
  } finally {
    await browser?.close();
    rmSync(profile, { recursive: true, force: true });
  }
}, 20_000);
