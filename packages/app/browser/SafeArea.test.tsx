import { expect, it } from "bun:test";
import { type Browser, launch } from "puppeteer-core";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";
import { stylesheets } from "./stylesheets";

const css = stylesheets(
  ["tokens", "base", "contextMenu", "dialog"],
  ["shell", "auth", "inbox"],
);

const fixtures = {
  shell: `
    <div class="shell">
      <aside class="sidebar" id="topBar"><div class="sidebarInner" id="sidebarInner">
        <div class="sidebarTop">Balebase</div>
      </div></aside>
      <main class="shellMain" id="main"><div style="height: 2400px"></div></main>
    </div>
    <div class="contextMenu" id="menu"></div>
    <dialog class="previewDialog" id="preview"></dialog>
    <dialog class="dialog" id="confirm"><div style="height: 2000px"></div></dialog>`,
  loading: `<div class="loadingScreen" id="topBar"><div id="main"></div></div>`,
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
    const preview = document.querySelector<HTMLDialogElement>("#preview");
    preview?.showModal();
    const previewStyle = preview && getComputedStyle(preview);
    const confirm = document.querySelector<HTMLDialogElement>("#confirm");
    confirm?.showModal();
    return {
      // Layout boxes, since the opening animation transforms the dialog.
      confirm: confirm && [
        confirm.offsetTop,
        confirm.offsetTop + confirm.offsetHeight,
      ],
      // ContextMenu.tsx reads these to keep menus clear of the bars.
      menuInsets: ["top", "right", "bottom", "left"].map((side) =>
        getComputedStyle(
          document.getElementById("menu") ?? document.body,
        ).getPropertyValue(`--safe-area-${side}`),
      ),
      preview: preview && {
        top: Math.round(preview.getBoundingClientRect().top),
        padding: [
          previewStyle?.paddingRight,
          previewStyle?.paddingBottom,
          previewStyle?.paddingLeft,
        ],
      },
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
      navigationStrips: (({ borderColor, borderWidth }) => [
        borderWidth,
        borderColor,
      ])(getComputedStyle(element("topBar"))),
    };
  });
}

it("keeps the app clear of the system bars it draws under", async () => {
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions());
    const phone = { top: 48, right: 0, bottom: 24, left: 0 };

    // The status bar sits on ink over the sticky top bar, which stays below it.
    const shell = await layOut(browser, "shell", 412, phone);
    expect(shell.band).toEqual({ color: "rgb(24, 25, 22)", height: "48px" });
    expect(shell.topBar).toEqual({ atRest: 48, scrolled: 48 });
    expect(shell.mainPadding).toEqual(["0px", "24px", "0px"]);
    expect(shell.menuInsets).toEqual(["48px", "0px", "24px", "0px"]);
    // A full-screen preview starts below the status bar and pads the rest.
    expect(shell.preview).toEqual({
      top: 48,
      padding: ["0px", "24px", "0px"],
    });
    // A tall dialog stays 16px inside the bars.
    expect(shell.confirm).toEqual([48 + 16, 800 - 24 - 16]);

    // Sign-in fills the screen without scrolling.
    const auth = await layOut(browser, "auth", 412, phone);
    expect(auth.band.height).toBe("48px");
    expect(auth.topBar.atRest).toBe(48);
    expect(auth.mainPadding[1]).toBe("48px");
    expect(auth.overflow).toBe(0);

    // Loading leaves the navigation bar's strip in the page color, which
    // its icons follow.
    const loading = await layOut(browser, "loading", 412, phone);
    expect(loading.navigationStrips).toEqual([
      "0px 0px 24px",
      "rgb(245, 244, 239)",
    ]);
    expect(loading.overflow).toBe(0);
    // Three-button navigation sits at a side edge in landscape.
    const sideways = await layOut(browser, "loading", 900, {
      top: 24,
      right: 48,
      bottom: 0,
      left: 0,
    });
    expect(sideways.navigationStrips[0]).toBe("0px 48px 0px 0px");

    // In landscape the cutout's side keeps the sidebar's links clear.
    const landscape = await layOut(browser, "shell", 900, {
      top: 24,
      right: 0,
      bottom: 24,
      left: 40,
    });
    expect(landscape.sidebarTop).toBe(24);
    expect(landscape.sidebarPaddingLeft).toBe("52px");
    expect(landscape.menuInsets[3]).toBe("40px");

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
    await closeChrome(browser);
  }
}, 20_000);
