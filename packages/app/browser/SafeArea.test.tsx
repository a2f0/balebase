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

const read = (url: URL) => readFileSync(fileURLToPath(url), "utf8");
const css = [
  ...["tokens", "base"].map((name) =>
    read(new URL(`../../ui/src/styles/${name}.css`, import.meta.url)),
  ),
  ...["shell", "auth"].map((name) =>
    read(new URL(`../src/styles/${name}.css`, import.meta.url)),
  ),
].join("\n");

const fixtures = {
  shell: `
    <div class="shell">
      <aside class="sidebar" id="topBar"><div class="sidebarInner" id="sidebarInner">
        <div class="sidebarTop">Balebase</div>
      </div></aside>
      <main class="shellMain" id="main"><div style="height: 2400px"></div></main>
    </div>`,
  auth: `
    <div class="authShell">
      <aside class="authAside" id="topBar"><div class="authAsideInner">
        <a class="authBrand" href="/">Balebase</a>
      </div></aside>
      <main class="authMain" id="main"><div class="authPanel">Sign in</div></main>
    </div>`,
};

interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Lays a screen out as the Android app does, drawn under the system bars. */
async function layOut(
  browser: Browser,
  screen: keyof typeof fixtures,
  width: number,
  insets: Insets,
) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 800, isMobile: width < 600 });
  const cdp = await page.createCDPSession();
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
  await page.setContent(
    `<!doctype html><html data-theme="light"><head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
      <style>${css}</style></head><body>${fixtures[screen]}</body></html>`,
  );
  return page.evaluate(() => {
    const element = (id: string) => {
      const found = document.getElementById(id);
      if (!found) throw new Error(`Missing ${id}`);
      return found;
    };
    const band = getComputedStyle(document.body, "::before");
    const main = getComputedStyle(element("main"));
    const top = (id: string) =>
      Math.round(element(id).getBoundingClientRect().top);
    const atRest = top("topBar");
    window.scrollTo(0, 600);
    return {
      band: { color: band.backgroundColor, height: band.height },
      topBar: { atRest, scrolled: top("topBar") },
      sidebarTop: document.getElementById("sidebarInner")
        ? top("sidebarInner")
        : undefined,
      mainPadding: [main.paddingRight, main.paddingBottom, main.paddingLeft],
      sidebarPaddingLeft: getComputedStyle(
        document.getElementById("sidebarInner") ?? document.body,
      ).paddingLeft,
      overflow: document.documentElement.scrollHeight - window.innerHeight,
    };
  });
}

it("keeps the app clear of the system bars it draws under", async () => {
  if (!existsSync(chrome))
    throw new Error("Chrome is required for the safe area check.");
  const profile = mkdtempSync(join(tmpdir(), "safe-area-"));
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
    const phone = { top: 48, right: 0, bottom: 24, left: 0 };

    // The status bar sits on ink over the sticky top bar, which stays below it.
    const shell = await layOut(browser, "shell", 412, phone);
    expect(shell.band).toEqual({ color: "rgb(24, 25, 22)", height: "48px" });
    expect(shell.topBar).toEqual({ atRest: 48, scrolled: 48 });
    expect(shell.mainPadding).toEqual(["0px", "24px", "0px"]);

    // Sign-in fills the screen without scrolling.
    const auth = await layOut(browser, "auth", 412, phone);
    expect(auth.band.height).toBe("48px");
    expect(auth.topBar.atRest).toBe(48);
    expect(auth.mainPadding[1]).toBe("48px");
    expect(auth.overflow).toBe(0);

    // In landscape the cutout's side keeps the sidebar's links clear.
    const landscape = await layOut(browser, "shell", 900, {
      top: 24,
      right: 0,
      bottom: 24,
      left: 40,
    });
    expect(landscape.sidebarTop).toBe(24);
    expect(landscape.sidebarPaddingLeft).toBe("52px");

    // Browsers and iOS, which report no insets, lay out as before.
    const web = await layOut(browser, "shell", 412, {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
    expect(web.band.height).toBe("0px");
    expect(web.topBar).toEqual({ atRest: 0, scrolled: 0 });
    expect(web.mainPadding).toEqual(["0px", "0px", "0px"]);
  } finally {
    await browser?.close();
    rmSync(profile, { recursive: true, force: true });
  }
}, 20_000);
