import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  mock,
  spyOn,
} from "bun:test";
import {
  Capacitor,
  SystemBarsStyle,
  type SystemBarsStyleOptions,
  SystemBarType,
} from "@capacitor/core";
import { Window } from "happy-dom";
import { syncStatusBarStyle } from "./statusBar";

const dom = new Window();
let platform: Mock<typeof Capacitor.getPlatform>;

beforeEach(() => {
  globalThis.MutationObserver =
    dom.MutationObserver as unknown as typeof MutationObserver;
  platform = spyOn(Capacitor, "getPlatform");
});

afterEach(() => {
  platform.mockRestore();
});

afterAll(async () => {
  await dom.happyDOM.close();
});

// Capacitor writes the status bar's height here on every insets pass.
async function reportInset(root: HTMLElement, value: string) {
  root.style.setProperty("--safe-area-inset-top", value);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("status bar style", () => {
  it("takes light icons while Android draws the page under the bar", async () => {
    platform.mockReturnValue("android");
    const root = dom.document.createElement("html") as unknown as HTMLElement;
    const setStyle = mock(async (_options: SystemBarsStyleOptions) => {});
    syncStatusBarStyle(root, { setStyle });
    expect(setStyle).not.toHaveBeenCalled();

    await reportInset(root, "48px");
    await reportInset(root, "52px");
    expect(setStyle.mock.calls).toEqual([
      [{ bar: SystemBarType.StatusBar, style: SystemBarsStyle.Dark }],
    ]);

    await reportInset(root, "0px");
    expect(setStyle).toHaveBeenLastCalledWith({
      bar: SystemBarType.StatusBar,
      style: SystemBarsStyle.Default,
    });
  });

  it("keeps the system style where the page stays below the bar", async () => {
    platform.mockReturnValue("android");
    const root = dom.document.createElement("html") as unknown as HTMLElement;
    const setStyle = mock(async (_options: SystemBarsStyleOptions) => {});
    syncStatusBarStyle(root, { setStyle });
    await reportInset(root, "0px");
    expect(setStyle).not.toHaveBeenCalled();
  });

  it("leaves iOS on its own style", async () => {
    platform.mockReturnValue("ios");
    const root = dom.document.createElement("html") as unknown as HTMLElement;
    const setStyle = mock(async (_options: SystemBarsStyleOptions) => {});
    syncStatusBarStyle(root, { setStyle });
    await reportInset(root, "48px");
    expect(setStyle).not.toHaveBeenCalled();
  });
});
