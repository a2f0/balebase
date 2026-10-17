import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

// Mounts the real app on an emailed reset link, so the session refreshes
// around the reset and the sign-in after it run exactly as in the browser.
const resetLink = "/reset-password?token=reset-token";
const dom = new Window({ url: `http://localhost:5173${resetLink}` });
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
let authClient: typeof import("./authClient").authClient;
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
  ({ authClient } = await import("./authClient"));
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

const people = {
  other: {
    email: "other@example.com",
    emailVerified: true,
    id: "user-2",
    name: "Other",
  },
  owner: {
    email: "owner@example.com",
    emailVerified: true,
    id: "user-1",
    name: "Owner",
  },
};
type Person = (typeof people)[keyof typeof people];

/**
 * Answers the auth endpoints for one browser. Like the server, resetting a
 * password revokes only that account's sessions.
 */
function stubAuth(signedIn: Person | null, resetFor: Person) {
  let active = signedIn;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input instanceof Request ? input.url : input))
      .pathname;
    if (path === "/api/auth/get-session") {
      return Response.json(
        active && {
          session: {
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            id: `session-${active.id}`,
            token: `token-${active.id}`,
            userId: active.id,
          },
          user: active,
        },
      );
    }
    if (path === "/api/auth/reset-password") {
      if (active?.id === resetFor.id) active = null;
      return Response.json({ status: true });
    }
    if (path === "/api/auth/sign-in/email") {
      const { email } = JSON.parse(String(init?.body));
      active =
        Object.values(people).find((person) => person.email === email) ?? null;
      return Response.json({ redirect: false, token: "token", user: active });
    }
    return Response.json([]);
  }) as typeof fetch;
}

async function settle() {
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Opens the reset link in a fresh mount of the app. */
async function openResetLink() {
  window.history.replaceState(null, "", resetLink);
  // The session store outlives a mount; fetch this browser's session afresh.
  authClient.$store.notify("$sessionSignal");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<App />));
  await settle();
  expect(heading()).toBe("Choose a new password");
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

async function resetPassword() {
  await fill("password", "correct horse battery");
  await fill("password-confirmation", "correct horse battery");
  await submit("Set new password");
  expect(window.location.search).toBe("");
  expect(container.textContent).toContain(
    "Password updated. Sign in with your new password.",
  );
}

async function signIn(person: Person, label: string) {
  await fill("email", person.email);
  await fill("password", "correct horse battery");
  await submit(label);
  expect(heading()).not.toBe("Choose a new password");
  expect(container.querySelector(".authShell")).toBeNull();
  expect(window.location.pathname).toBe("/");
}

describe("password reset", () => {
  it("signs in with the new password instead of asking for another reset", async () => {
    stubAuth(null, people.owner);
    await openResetLink();

    await resetPassword();
    expect(window.location.pathname).toBe("/");
    expect(heading()).toBe("Enter your workspace");

    await signIn(people.owner, "Sign in");
  });

  it("asks a browser signed in to the reset account to sign in again", async () => {
    stubAuth(people.owner, people.owner);
    await openResetLink();

    await resetPassword();
    expect(window.location.pathname).toBe("/");
    expect(heading()).toBe("Enter your workspace");

    await signIn(people.owner, "Sign in");
  });

  it("adds the reset account beside another account still signed in", async () => {
    stubAuth(people.other, people.owner);
    await openResetLink();

    await resetPassword();
    expect(window.location.pathname).toBe("/add-account");
    expect(heading()).toBe("Sign in to another account");

    await signIn(people.owner, "Add account");
  });
});
