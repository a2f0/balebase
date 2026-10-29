// The Chromium the web shell's browser suites share (chromium.ts): its
// switches, and its teardown, including when it won't close.

import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  browserProcess,
  closeChromium,
  DISABLED_FEATURES,
  launchChromium,
  PLAYWRIGHT_DISABLED_FEATURES,
} from "./chromium";

// Launching took under 1.5 s at load 40, and closing is bounded at 4 s.
const timeout = 15_000;

function commandLine(pid: number) {
  return Bun.spawnSync([
    "ps",
    "-ww",
    "-o",
    "command=",
    "-p",
    String(pid),
  ]).stdout.toString();
}

/** Whether `pid`, or with a negative `pid` any process in that group, runs. */
function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits briefly for the browser's process group to empty: helpers can
 * outlive the browser process by a moment before they are reaped.
 */
async function groupExits(pid: number) {
  const deadline = performance.now() + 2_000;
  while (running(-pid) && performance.now() < deadline) await Bun.sleep(50);
  return !running(-pid);
}

test(
  "repeats Playwright's disabled features, adds the key deletion, and closes cleanly",
  async () => {
    const browser = await launchChromium();
    const pid = await browserProcess(browser);
    const command = commandLine(pid);
    const lists = [...command.matchAll(/--disable-features=(\S+)/g)].map(
      ([, list = ""]) => list.split(","),
    );
    // Playwright's switch, then ours, the one Chrome reads.
    expect(lists).toEqual([PLAYWRIGHT_DISABLED_FEATURES, DISABLED_FEATURES]);
    const profile = command.match(/--user-data-dir=(\S+)/)?.[1] ?? "";
    expect(existsSync(profile)).toBe(true);
    // A context left open, as the update suite leaves its own, closes too.
    const page = await browser.newPage();
    await page.goto("data:text/html,<p>open</p>");
    await closeChromium(browser);
    expect(browser.isConnected()).toBe(false);
    expect(await groupExits(pid)).toBe(true);
    expect(existsSync(profile)).toBe(false);
  },
  timeout,
);

test(
  "kills a Chromium that doesn't close in its budget, and says so",
  async () => {
    const browser = await launchChromium();
    const pid = await browserProcess(browser);
    const profile = commandLine(pid).match(/--user-data-dir=(\S+)/)?.[1] ?? "";
    const page = await browser.newPage();
    await page.goto("data:text/html,<p>hung</p>");
    // A stopped browser answers nothing, as a hung one wouldn't.
    process.kill(pid, "SIGSTOP");
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await closeChromium(browser, 500);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("so it was killed");
    } finally {
      warn.mockRestore();
    }
    expect(browser.isConnected()).toBe(false);
    expect(await groupExits(pid)).toBe(true);
    expect(existsSync(profile)).toBe(false);
  },
  timeout,
);
