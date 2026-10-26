import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Select } from "@balebase/ui/react";
import { type Browser, launch } from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";

const { CHROME_PATH } = process.env;
const chrome =
  CHROME_PATH ||
  Bun.which("google-chrome") ||
  Bun.which("chromium") ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const read = (url: URL) => readFileSync(fileURLToPath(url), "utf8");
const css = [
  ...["tokens", "base", "controls", "surfaces"].map((name) =>
    read(new URL(`../../ui/src/styles/${name}.css`, import.meta.url)),
  ),
  read(new URL("../src/styles/shell.css", import.meta.url)),
].join("\n");

const fixture = `
  <button class="button buttonSm" id="small">Edit</button>
  <button class="button" id="medium">Save</button>
  <div class="segmented"><button aria-pressed="true" id="segment">Grid</button><button>List</button></div>
  <input class="input inputSm" id="smallInput">
  ${renderToStaticMarkup(
    <Select id="select">
      <option>Member</option>
    </Select>,
  )}
  <label class="check" id="check"><input type="checkbox"><span>Required</span></label>
  <div><a class="rowTitle" href="#issue" id="rowTitle">Inventory spreadsheet</a></div>
  <nav><a class="navItem" href="#library" id="navItem">Library</a></nav>
  <button class="codeChip" id="codeChip">upload+team@inbox.example</button>
`;

async function measure(browser: Browser, touch: boolean) {
  const page = await browser.newPage();
  await page.setViewport({
    width: touch ? 375 : 1280,
    height: 800,
    isMobile: touch,
    hasTouch: touch,
  });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body>${fixture}</body></html>`,
  );
  return page.evaluate(() => {
    const box = (id: string) => {
      const element = document.getElementById(id);
      if (!element) throw new Error(`Missing ${id}`);
      return element.getBoundingClientRect();
    };
    const fontSize = (id: string) =>
      getComputedStyle(document.getElementById(id) as Element).fontSize;
    return {
      coarse: matchMedia("(pointer: coarse)").matches,
      heights: Object.fromEntries(
        [
          "small",
          "medium",
          "segment",
          "smallInput",
          "select",
          "check",
          "rowTitle",
          "navItem",
          "codeChip",
        ].map((id) => [id, Math.round(box(id).height)]),
      ),
      inputFonts: [fontSize("smallInput"), fontSize("select")],
    };
  });
}

it("touch screens get fingertip-sized controls while a mouse keeps compact ones", async () => {
  if (!existsSync(chrome))
    throw new Error("Chrome is required for the touch target check.");
  const profile = mkdtempSync(join(tmpdir(), "touch-targets-"));
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
    const touch = await measure(browser, true);
    expect(touch.coarse).toBe(true);
    // iOS zooms into any focused field set below 16px.
    expect(touch.inputFonts).toEqual(["16px", "16px"]);
    for (const [id, height] of Object.entries(touch.heights)) {
      // The segmented control's 3px inset keeps each option at 40px.
      const minimum =
        id === "segment" || id === "rowTitle" || id === "codeChip" ? 40 : 44;
      expect(height, id).toBeGreaterThanOrEqual(minimum);
    }

    const mouse = await measure(browser, false);
    expect(mouse.coarse).toBe(false);
    expect(mouse.inputFonts).toEqual(["13px", "15px"]);
    expect(mouse.heights).toMatchObject({
      small: 32,
      medium: 40,
      segment: 30,
      smallInput: 32,
      select: 40,
      navItem: 38,
    });
  } finally {
    await browser?.close();
    rmSync(profile, { recursive: true, force: true });
  }
}, 20_000);
