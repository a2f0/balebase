import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { AuthPage } from "./AuthPage";
import { configureHost, type NativeHost } from "./host";

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

describe("saving passwords in the native app", () => {
  const credentials = {
    email: "owner@example.com",
    password: "correct horse battery",
  };
  let offered: Array<[string, string]>;
  let authenticated: number;

  afterEach(() => configureHost({}));

  /** Renders sign-in in a native shell whose sign-in endpoints answer as given. */
  async function renderNativeSignIn(
    answer: (path: string) => Response,
    savePassword = async (username: string, password: string) => {
      offered.push([username, password]);
    },
    chooseSavedSignIn?: NativeHost["chooseSavedSignIn"],
  ) {
    offered = [];
    authenticated = 0;
    configureHost({
      native: {
        appUrl: "https://app.test",
        origin: "https://localhost",
        saveFile: async () => true,
        savePassword,
        chooseSavedSignIn,
      },
    });
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      answer(new URL(String(input)).pathname)) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <AuthPage
          initialMode="sign-in"
          onAuthenticated={async () => {
            authenticated += 1;
          }}
          onLeaveReset={async () => {}}
        />,
      ),
    );
  }

  async function fill(
    fields: Record<string, string>,
    source: "script" | "autofill" | "typing" | "paste" = "script",
  ) {
    const setValue = Object.getOwnPropertyDescriptor(
      dom.HTMLInputElement.prototype,
      "value",
    )?.set;
    for (const [selector, value] of Object.entries(fields)) {
      const input = container.querySelector<HTMLInputElement>(selector);
      if (!input) throw new Error(`No ${selector} input`);
      await act(async () => {
        setValue?.call(input, value);
        const event =
          source === "typing" || source === "paste"
            ? new dom.InputEvent("input", {
                bubbles: true,
                inputType:
                  source === "paste" ? "insertFromPaste" : "insertText",
              })
            : new dom.Event("input", { bubbles: true });
        // Model the native events sent by WebKit. Happy DOM cannot invoke an
        // OS password manager; the simulator check covers that boundary.
        Object.defineProperty(event, "isTrusted", {
          value: source !== "script",
        });
        input.dispatchEvent(event as never);
      });
    }
  }

  async function submit(fields: Record<string, string> = {}) {
    await fill(fields);
    const form = container.querySelector("form");
    if (!form) throw new Error("No form");
    await act(async () => {
      form.dispatchEvent(
        new dom.Event("submit", { bubbles: true, cancelable: true }) as never,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  const signIn = () =>
    submit({
      'input[name="email"]': credentials.email,
      'input[name="password"]': credentials.password,
    });

  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("offers the password once it signs in", async () => {
    await renderNativeSignIn(() =>
      Response.json({ redirect: false, token: "token", user: {} }),
    );
    await signIn();
    expect(offered).toEqual([[credentials.email, credentials.password]]);
    expect(authenticated).toBe(1);
  });

  const fillSaved = () =>
    fill(
      {
        'input[name="email"]': credentials.email,
        'input[name="password"]': credentials.password,
      },
      "autofill",
    );

  it("does not offer credentials filled by the iOS keyboard again", async () => {
    await renderNativeSignIn(() => Response.json({ token: "token", user: {} }));
    await fillSaved();
    await submit();
    expect(authenticated).toBe(1);
    expect(offered).toEqual([]);
  });

  it("keeps autofill provenance through a second-factor retry", async () => {
    let attempts = 0;
    await renderNativeSignIn((path) =>
      path.endsWith("/sign-in/email")
        ? Response.json({ twoFactorRedirect: true })
        : ++attempts === 1
          ? Response.json({ message: "Invalid code" }, { status: 401 })
          : Response.json({ token: "token", user: {} }),
    );
    await fillSaved();
    await submit();
    await submit({ "#two-factor-code": "000000" });
    expect(authenticated).toBe(0);
    await submit({ "#two-factor-code": "123456" });
    expect(authenticated).toBe(1);
    expect(offered).toEqual([]);
  });

  for (const [field, value] of [
    ["email", "other@example.com"],
    ["password", "a changed password"],
  ] as const) {
    it(`offers to save an autofilled login after its ${field} changes`, async () => {
      await renderNativeSignIn(() =>
        Response.json({ token: "token", user: {} }),
      );
      await fillSaved();
      await submit({ [`input[name="${field}"]`]: value ?? "" });
      expect(offered).toEqual([
        [
          field === "email" ? value : credentials.email,
          field === "password" ? value : credentials.password,
        ],
      ]);
    });
  }

  for (const source of ["typing", "paste"] as const) {
    it(`still offers a password supplied by ${source}`, async () => {
      await renderNativeSignIn(() =>
        Response.json({ token: "token", user: {} }),
      );
      await fill(
        {
          'input[name="email"]': credentials.email,
          'input[name="password"]': credentials.password,
        },
        source,
      );
      await submit();
      expect(offered).toEqual([[credentials.email, credentials.password]]);
    });
  }

  async function chooseSaved() {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Use saved sign-in",
    );
    if (!button) throw new Error("No saved sign-in action");
    await act(async () => button.click());
  }

  it("fills the saved email and password together without another save offer", async () => {
    await renderNativeSignIn(
      () => Response.json({ token: "token", user: {} }),
      undefined,
      async () => ({
        username: credentials.email,
        password: credentials.password,
      }),
    );
    await chooseSaved();
    expect(
      container.querySelector<HTMLInputElement>('[name="email"]')?.value,
    ).toBe(credentials.email);
    expect(
      container.querySelector<HTMLInputElement>('[name="password"]')?.value,
    ).toBe(credentials.password);
    expect(authenticated).toBe(0);
    await submit();
    expect(authenticated).toBe(1);
    expect(offered).toEqual([]);
  });

  it("leaves manual sign-in available after cancelling the password picker", async () => {
    await renderNativeSignIn(
      () => Response.json({ token: "token", user: {} }),
      undefined,
      async () => undefined,
    );
    await fill({ 'input[name="email"]': credentials.email });
    await chooseSaved();
    expect(
      container.querySelector<HTMLInputElement>('[name="email"]')?.value,
    ).toBe(credentials.email);
    await signIn();
    expect(authenticated).toBe(1);
    expect(offered).toEqual([[credentials.email, credentials.password]]);
  });

  it("leaves manual sign-in available when the password picker fails", async () => {
    await renderNativeSignIn(
      () => Response.json({ token: "token", user: {} }),
      undefined,
      async () => {
        throw new Error("Saved sign-ins unavailable");
      },
    );
    await chooseSaved();
    expect(container.textContent).toContain("Saved sign-ins unavailable");
    await signIn();
    expect(authenticated).toBe(1);
    expect(offered).toEqual([[credentials.email, credentials.password]]);
  });

  it("waits for the second factor before offering the password", async () => {
    await renderNativeSignIn((path) =>
      path.endsWith("/sign-in/email")
        ? Response.json({ twoFactorRedirect: true })
        : Response.json({ token: "token", user: {} }),
    );
    await signIn();
    expect(container.querySelector("h1")?.textContent).toBe("Confirm it’s you");
    expect(offered).toEqual([]);

    await submit({ "#two-factor-code": "123456" });
    expect(offered).toEqual([[credentials.email, credentials.password]]);
    expect(authenticated).toBe(1);
  });

  it("never offers a password that failed to sign in", async () => {
    await renderNativeSignIn(() =>
      Response.json(
        { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid password" },
        { status: 401 },
      ),
    );
    await signIn();
    expect(container.textContent).toContain("Invalid password");
    expect(offered).toEqual([]);
    expect(authenticated).toBe(0);
  });

  it("signs in when saving the password fails", async () => {
    await renderNativeSignIn(
      () => Response.json({ redirect: false, token: "token", user: {} }),
      async () => {
        throw new Error("No password manager");
      },
    );
    await signIn();
    expect(authenticated).toBe(1);
    expect(container.textContent).not.toContain("No password manager");
  });
});
