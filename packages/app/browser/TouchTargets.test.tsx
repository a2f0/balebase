import { expect, it } from "bun:test";
import { Select } from "@balebase/ui/react";
import { type Browser, launch } from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";
import { stylesheets } from "./stylesheets";

const css = stylesheets(["tokens", "base", "controls", "surfaces"], ["shell"]);

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
  ${renderToStaticMarkup(
    <Select className="inputSm" id="selectSm">
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
          "selectSm",
          "check",
          "rowTitle",
          "navItem",
          "codeChip",
        ].map((id) => [id, Math.round(box(id).height)]),
      ),
      inputFonts: [
        fontSize("smallInput"),
        fontSize("select"),
        fontSize("selectSm"),
      ],
    };
  });
}

it("touch screens get fingertip-sized controls while a mouse keeps compact ones", async () => {
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions());
    const touch = await measure(browser, true);
    expect(touch.coarse).toBe(true);
    // iOS zooms into any focused field set below 16px.
    expect(touch.inputFonts).toEqual(["16px", "16px", "16px"]);
    for (const [id, height] of Object.entries(touch.heights)) {
      // The segmented control's 3px inset keeps each option at 40px.
      const minimum =
        id === "segment" || id === "rowTitle" || id === "codeChip" ? 40 : 44;
      expect(height, id).toBeGreaterThanOrEqual(minimum);
    }

    const mouse = await measure(browser, false);
    expect(mouse.coarse).toBe(false);
    expect(mouse.inputFonts).toEqual(["13px", "15px", "13px"]);
    expect(mouse.heights).toMatchObject({
      small: 32,
      medium: 40,
      segment: 30,
      smallInput: 32,
      select: 40,
      selectSm: 32,
      navItem: 38,
    });
  } finally {
    await closeChrome(browser);
  }
}, 20_000);
