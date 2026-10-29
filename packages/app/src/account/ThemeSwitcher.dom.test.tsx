import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { act } from "react";
import { installDom } from "../testing/dom";
import { themeStorageKey } from "./theme";

const {
  button,
  mount,
  window: dom,
} = installDom({ url: "http://localhost:5173" });
let ThemeSwitcher: typeof import("./ThemeSwitcher").ThemeSwitcher;
let setThemePreference: typeof import("./theme").setThemePreference;
let startThemeSync: typeof import("./theme").startThemeSync;
let stopThemeSync: (() => void) | undefined;
let container: HTMLElement;

// A controllable stand-in for the prefers-color-scheme media query.
const systemScheme = { dark: false, listeners: new Set<() => void>() };

function setSystemDark(dark: boolean) {
  systemScheme.dark = dark;
  for (const listener of systemScheme.listeners) listener();
}

beforeAll(async () => {
  Object.defineProperty(dom, "matchMedia", {
    configurable: true,
    value: () => ({
      get matches() {
        return systemScheme.dark;
      },
      addEventListener: (_type: string, listener: () => void) =>
        systemScheme.listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) =>
        systemScheme.listeners.delete(listener),
    }),
  });
  ({ ThemeSwitcher } = await import("./ThemeSwitcher"));
  ({ setThemePreference, startThemeSync } = await import("./theme"));
});

beforeEach(() => {
  systemScheme.dark = false;
  setThemePreference("system");
  dom.localStorage.clear();
});

afterEach(() => {
  stopThemeSync?.();
  stopThemeSync = undefined;
});

async function mountSwitcher(menu = false) {
  ({ container } = await mount(
    menu ? (
      <>
        <p id="theme-label">Theme</p>
        <ThemeSwitcher labelledBy="theme-label" menu />
      </>
    ) : (
      <ThemeSwitcher />
    ),
  ));
}

const appliedTheme = () => document.documentElement.getAttribute("data-theme");

describe("theme switcher", () => {
  it("applies and remembers the chosen theme", async () => {
    stopThemeSync = startThemeSync();
    await mountSwitcher();
    expect(button("System").getAttribute("aria-pressed")).toBe("true");
    expect(appliedTheme()).toBe("light");

    await act(async () => button("Dark").click());
    expect(button("Dark").getAttribute("aria-pressed")).toBe("true");
    expect(button("System").getAttribute("aria-pressed")).toBe("false");
    expect(appliedTheme()).toBe("dark");
    expect(dom.localStorage.getItem(themeStorageKey)).toBe("dark");

    await act(async () => button("Light").click());
    expect(appliedTheme()).toBe("light");
  });

  it("renders menu radio items inside a menu", async () => {
    setThemePreference("light");
    await mountSwitcher(true);
    const items = container.querySelectorAll('[role="menuitemradio"]');
    expect(items).toHaveLength(3);
    expect(button("Light").getAttribute("aria-checked")).toBe("true");
    expect(button("Light").hasAttribute("aria-pressed")).toBe(false);
    expect(
      container.querySelector("fieldset")?.getAttribute("aria-labelledby"),
    ).toBe("theme-label");
    expect(container.querySelector("legend")).toBeNull();
  });

  it("follows a preference changed in another tab", async () => {
    stopThemeSync = startThemeSync();
    await mountSwitcher();
    await act(async () => {
      dom.dispatchEvent(
        new dom.StorageEvent("storage", {
          key: themeStorageKey,
          newValue: "dark",
        }) as never,
      );
    });
    expect(button("Dark").getAttribute("aria-pressed")).toBe("true");
    expect(appliedTheme()).toBe("dark");
  });
});

describe("theme sync", () => {
  it("follows the system scheme only while System is chosen", async () => {
    stopThemeSync = startThemeSync();
    expect(appliedTheme()).toBe("light");
    await act(async () => setSystemDark(true));
    expect(appliedTheme()).toBe("dark");
    await act(async () => setSystemDark(false));
    expect(appliedTheme()).toBe("light");

    await act(async () => setThemePreference("dark"));
    await act(async () => setSystemDark(false));
    expect(appliedTheme()).toBe("dark");
    await act(async () => setThemePreference("light"));
    await act(async () => setSystemDark(true));
    expect(appliedTheme()).toBe("light");
  });

  it("stops following the system and other tabs after cleanup", async () => {
    const stop = startThemeSync();
    expect(systemScheme.listeners.size).toBe(1);
    stop();
    expect(systemScheme.listeners.size).toBe(0);

    await act(async () => setSystemDark(true));
    dom.dispatchEvent(
      new dom.StorageEvent("storage", {
        key: themeStorageKey,
        newValue: "dark",
      }) as never,
    );
    expect(appliedTheme()).toBe("light");
  });
});
