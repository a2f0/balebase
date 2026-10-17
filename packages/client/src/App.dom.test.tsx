import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

// Mounts the real app on an emailed reset link, so the session refresh after
// signing in runs exactly as it does in the browser.
const dom = new Window({
  url: "http://localhost:5173/reset-password?token=reset-token",
});
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
const originalFetch = globalThis.fetch;
let App: typeof import("./App").App;
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
  ({ App } = await import("./App"));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

const user = {
  email: "person@example.com",
  emailVerified: true,
  id: "user-1",
  name: "Person",
};

/** Signed out until the sign-in request succeeds; records auth requests. */
function stubAuth() {
  const requests: string[] = [];
  let signedIn = false;
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input instanceof Request ? input.url : input))
      .pathname;
    if (path.startsWith("/api/auth/")) requests.push(path);
    if (path === "/api/auth/get-session") {
      return Response.json(
        signedIn
          ? {
              session: {
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                id: "session-1",
                token: "session-token",
                userId: user.id,
              },
              user,
            }
          : null,
      );
    }
    if (path === "/api/auth/reset-password") {
      return Response.json({ status: true });
    }
    if (path === "/api/auth/sign-in/email") {
      signedIn = true;
      return Response.json({ redirect: false, token: "session-token", user });
    }
    return Response.json([]);
  }) as typeof fetch;
  return requests;
}

async function settle() {
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const heading = () => container.querySelector("h1")?.textContent;

async function fill(name: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(
    `input[name="${name}"]`,
  );
  expect(field).toBeTruthy();
  const setValue = Object.getOwnPropertyDescriptor(
    dom.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setValue?.call(field, value);
    field?.dispatchEvent(new dom.Event("input", { bubbles: true }) as never);
  });
}

async function submit(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(button).toBeTruthy();
  await act(async () => button?.click());
  await settle();
}

describe("password reset", () => {
  it("signs in with the new password instead of asking for another reset", async () => {
    const requests = stubAuth();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    await settle();
    expect(heading()).toBe("Choose a new password");

    await fill("password", "correct horse battery");
    await fill("password-confirmation", "correct horse battery");
    await submit("Set new password");
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    expect(heading()).toBe("Enter your workspace");
    expect(container.textContent).toContain(
      "Password updated. Sign in with your new password.",
    );

    await fill("email", user.email);
    await fill("password", "correct horse battery");
    await submit("Sign in");
    expect(requests).toContain("/api/auth/sign-in/email");
    expect(heading()).not.toBe("Choose a new password");
    expect(container.querySelector(".authShell")).toBeNull();
  });
});
