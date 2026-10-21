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
import { syncSystemBars } from "./systemBars";

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

function start(theme = "light") {
  const root = dom.document.createElement("html") as unknown as HTMLElement;
  root.setAttribute("data-theme", theme);
  const setStyle = mock(async (_options: SystemBarsStyleOptions) => {});
  syncSystemBars(root, { setStyle });
  return { root, setStyle };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Capacitor writes the status bar's height here on every insets pass.
async function reportInset(root: HTMLElement, value: string) {
  root.style.setProperty("--safe-area-inset-top", value);
  await settle();
}

const status = (style: SystemBarsStyle) => ({
  bar: SystemBarType.StatusBar,
  style,
});
const navigation = (style: SystemBarsStyle) => ({
  bar: SystemBarType.NavigationBar,
  style,
});

describe("system bar styles", () => {
  it("match what Android draws under the bars", async () => {
    platform.mockReturnValue("android");
    const { root, setStyle } = start();
    expect(setStyle).not.toHaveBeenCalled();

    await reportInset(root, "48px");
    await reportInset(root, "52px");
    expect(setStyle.mock.calls).toEqual([
      [status(SystemBarsStyle.Dark)],
      [navigation(SystemBarsStyle.Light)],
    ]);

    await reportInset(root, "0px");
    expect(setStyle.mock.calls.slice(2)).toEqual([
      [status(SystemBarsStyle.Default)],
      [navigation(SystemBarsStyle.Default)],
    ]);
  });

  it("follow the app's theme on the navigation bar", async () => {
    platform.mockReturnValue("android");
    const { root, setStyle } = start("dark");
    await reportInset(root, "48px");
    expect(setStyle).toHaveBeenLastCalledWith(navigation(SystemBarsStyle.Dark));

    root.setAttribute("data-theme", "light");
    await settle();
    expect(setStyle).toHaveBeenLastCalledWith(
      navigation(SystemBarsStyle.Light),
    );
    expect(setStyle).toHaveBeenCalledTimes(3);
  });

  it("keep the system style where the page stays clear of the bars", async () => {
    platform.mockReturnValue("android");
    const { root, setStyle } = start("dark");
    await reportInset(root, "0px");
    root.setAttribute("data-theme", "light");
    await settle();
    expect(setStyle).not.toHaveBeenCalled();
  });

  it("leave iOS on its own style", async () => {
    platform.mockReturnValue("ios");
    const { root, setStyle } = start();
    await reportInset(root, "48px");
    expect(setStyle).not.toHaveBeenCalled();
  });
});
