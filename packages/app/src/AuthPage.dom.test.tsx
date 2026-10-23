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
  it("moves focus to each new form's heading", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <AuthPage
          initialMode="sign-in"
          onAuthenticated={async () => {}}
          onLeaveReset={async () => {}}
        />,
      ),
    );
    const button = (label: string) => {
      const match = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      if (!match) throw new Error(`No ${label} button`);
      return match;
    };
    const focusedHeading = () =>
      document.activeElement?.matches("h1")
        ? document.activeElement.textContent
        : document.activeElement?.tagName;
    expect(focusedHeading()).toBe("BODY");

    await act(async () => button("Create an account").click());
    expect(focusedHeading()).toBe("Create your workspace");
    await act(async () => button("Back to sign in").click());
    expect(focusedHeading()).toBe("Enter your workspace");
    await act(async () => button("Forgot password?").click());
    expect(focusedHeading()).not.toBe("Enter your workspace");
    expect(document.activeElement?.matches("h1")).toBe(true);
    await act(async () => button("Back to sign in").click());

    // Two-step verification replaces the sign-in form, and cancelling it
    // brings the sign-in form back.
    const signIns: string[] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      signIns.push(String(input));
      return Response.json({ twoFactorRedirect: true });
    }) as typeof fetch;
    try {
      const form = container.querySelector("form");
      if (!form) throw new Error("No sign-in form");
      await act(async () =>
        form.dispatchEvent(
          new dom.Event("submit", {
            bubbles: true,
            cancelable: true,
          }) as unknown as Event,
        ),
      );
      expect(signIns.some((url) => url.endsWith("/sign-in/email"))).toBe(true);
      expect(focusedHeading()).toBe("Confirm it’s you");
      await act(async () => button("Back to sign in").click());
      expect(focusedHeading()).toBe("Enter your workspace");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

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
    // Revealed text must not reach spelling or autocorrect services.
    expect(password.getAttribute("spellcheck")).toBe("false");
    expect(password.getAttribute("autocorrect")).toBe("off");
    expect(password.getAttribute("autocapitalize")).toBe("none");
    expect(toggles[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(toggles[0]?.title).toBe("Hide password");

    await act(async () => toggles[0]?.click());
    expect(password.type).toBe("password");
    expect(toggles[0]?.getAttribute("aria-pressed")).toBe("false");

    // A password revealed on one form starts hidden on the next.
    await act(async () => toggles[0]?.click());
    const signIn = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Back to sign in",
    );
    await act(async () => signIn?.click());
    expect(input("password").type).toBe("password");
    expect(
      container.querySelector(".passwordToggle")?.getAttribute("aria-pressed"),
    ).toBe("false");
  });
});
