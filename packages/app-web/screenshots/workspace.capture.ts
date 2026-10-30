import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "playwright/test";
import {
  clearLayout,
  openScreen,
  pinTheme,
  screens,
  screenshotRoot,
  signIn,
  themes,
} from "./screens";

// Each project is a layout (web, ipad, mobile), captured once per theme.
test("captures the workspace screens", async ({ page }, testInfo) => {
  const layout = testInfo.project.name;
  await clearLayout(layout);
  await signIn(page, testInfo);
  for (const theme of themes) {
    const directory = path.join(screenshotRoot, layout, theme);
    await mkdir(directory, { recursive: true });
    await pinTheme(page, theme);
    for (const screen of screens) {
      await test.step(`${theme} ${screen.name}`, async () => {
        await openScreen(page, screen);
        await page.screenshot({
          path: path.join(directory, `${screen.name}.png`),
        });
      });
    }
  }
});
