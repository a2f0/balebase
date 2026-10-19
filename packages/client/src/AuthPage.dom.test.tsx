import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { AuthPage } from "./AuthPage";

const dom = new Window({ url: "http://localhost:5173/" });
const domGlobals = {
  document: dom.document,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.navigator,
  Node: dom.Node,
  window: dom,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
let createRoot: (container: Element) => Root;
let root: Root | undefined;
let container: HTMLElement;

beforeAll(async () => {
  for (const [key, value] of Object.entries(domGlobals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  ({ createRoot } = await import("react-dom/client"));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

describe("registration", () => {
  it("shows and hides each password on request", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <AuthPage
          initialMode="sign-up"
          onAuthenticated={async () => {}}
          onLeaveReset={async () => {}}
        />,
      ),
    );
    const input = (name: string) => {
      const match = container.querySelector<HTMLInputElement>(
        `input[name="${name}"]`,
      );
      if (!match) throw new Error(`No ${name} input`);
      return match;
    };
    const password = input("password");
    const confirmation = input("password-confirmation");
    expect(container.querySelector('label[for="password"]')?.textContent).toBe(
      "New password",
    );
    expect(password.getAttribute("aria-describedby")).toBe("password-hint");
    const toggles = [
      ...container.querySelectorAll<HTMLButtonElement>(".passwordToggle"),
    ];
    expect(toggles.map((toggle) => toggle.getAttribute("aria-label"))).toEqual([
      "Show password",
      "Show password",
    ]);
    expect([password.type, confirmation.type]).toEqual([
      "password",
      "password",
    ]);

    await act(async () => toggles[0]?.click());
    expect([password.type, confirmation.type]).toEqual(["text", "password"]);
    expect(toggles[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(toggles[0]?.title).toBe("Hide password");

    await act(async () => toggles[0]?.click());
    expect(password.type).toBe("password");
    expect(toggles[0]?.getAttribute("aria-pressed")).toBe("false");
  });
});
