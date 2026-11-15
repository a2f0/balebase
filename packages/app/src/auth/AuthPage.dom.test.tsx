import { afterEach, describe, expect, it } from "bun:test";
import { act, StrictMode } from "react";
import { configureHost, type NativeHost, type SavedSignIn } from "../host";
import { installDom } from "../testing/dom";
import { AuthPage } from "./AuthPage";

const {
  button,
  click,
  mount,
  respond,
  window: dom,
} = installDom({
  url: "http://localhost:5173/",
  globals: (window) => ({
    HTMLInputElement: window.HTMLInputElement,
  }),
});
let container: HTMLElement;

describe("registration", () => {
  it("moves focus to each new form's heading", async () => {
    ({ container } = await mount(
      <AuthPage
        initialMode="sign-in"
        onAuthenticated={async () => {}}
        onLeaveReset={async () => {}}
      />,
    ));
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
    respond(async (url) => {
      signIns.push(url.href);
      return Response.json({ twoFactorRedirect: true });
    });
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
  });

  it("shows and hides each password on request", async () => {
    ({ container } = await mount(
      <AuthPage
        initialMode="sign-up"
        onAuthenticated={async () => {}}
        onLeaveReset={async () => {}}
      />,
    ));
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
        chooseSavedSignIn,
        origin: "https://localhost",
        saveFile: async () => true,
        savePassword,
      },
    });
    respond(async (url) => answer(url.pathname));
    // Production renders in StrictMode, which replays mount effects.
    ({ container } = await mount(
      <StrictMode>
        <AuthPage
          initialMode="sign-in"
          onAuthenticated={async () => {
            authenticated += 1;
          }}
          onLeaveReset={async () => {}}
        />
      </StrictMode>,
    ));
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
      await submit({ [`input[name="${field}"]`]: value });
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

  it("forgets autofill provenance when leaving sign-in", async () => {
    await renderNativeSignIn(() => Response.json({ token: "token", user: {} }));
    await fillSaved();
    await click("Forgot password?");
    await click("Back to sign in");
    await signIn();
    expect(offered).toEqual([[credentials.email, credentials.password]]);
  });

  it("keeps sign-in working when the WebView does not recognize :autofill", async () => {
    await renderNativeSignIn(() => Response.json({ token: "token", user: {} }));
    const email = container.querySelector<HTMLInputElement>('[name="email"]');
    if (!email) throw new Error("No email input");
    const matches = email.matches.bind(email);
    Object.defineProperty(email, "matches", {
      value: (selector: string) => {
        if (selector === ":autofill")
          throw new SyntaxError("Unsupported selector");
        return matches(selector);
      },
    });
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

  const value = (name: string) =>
    container.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value;
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  it("fills a chosen saved sign-in without offering to save it again", async () => {
    let requests = 0;
    await renderNativeSignIn(
      () => Response.json({ token: "token", user: {} }),
      undefined,
      async () => {
        requests += 1;
        return { username: credentials.email, password: credentials.password };
      },
    );
    await settle();
    expect(requests).toBe(1);
    expect([value("email"), value("password")]).toEqual([
      credentials.email,
      credentials.password,
    ]);
    await submit();
    expect(authenticated).toBe(1);
    expect(offered).toEqual([]);
  });

  const unanswered: Array<[string, () => Promise<SavedSignIn | undefined>]> = [
    ["none is chosen", async () => undefined],
    [
      "the password manager fails",
      async () => {
        throw new Error("No credential provider");
      },
    ],
  ];
  for (const [outcome, choose] of unanswered) {
    it(`asks once and signs in by typing when ${outcome}`, async () => {
      let requests = 0;
      await renderNativeSignIn(
        () => Response.json({ token: "token", user: {} }),
        undefined,
        () => {
          requests += 1;
          return choose();
        },
      );
      await settle();
      expect(value("password")).toBe("");
      await click("Forgot password?");
      await click("Back to sign in");
      await settle();
      expect(requests).toBe(1);
      await signIn();
      expect(authenticated).toBe(1);
      expect(offered).toEqual([[credentials.email, credentials.password]]);
      expect(container.textContent).not.toContain("No credential provider");
    });
  }

  /** Renders sign-in whose saved sign-in offer answers only when told to. */
  async function renderPendingOffer(answer: (path: string) => Response) {
    const pending = { requests: 0, choose: (_: SavedSignIn) => {} };
    await renderNativeSignIn(answer, undefined, () => {
      const { promise, resolve } = Promise.withResolvers<
        SavedSignIn | undefined
      >();
      pending.requests += 1;
      pending.choose = resolve;
      return promise;
    });
    return pending;
  }
  const savedElsewhere = {
    username: "saved@example.com",
    password: "a saved password",
  };

  it("ignores a saved sign-in chosen after leaving sign-in", async () => {
    const pending = await renderPendingOffer(() =>
      Response.json({ token: "token", user: {} }),
    );
    await fill({ 'input[name="email"]': credentials.email });
    await click("Forgot password?");
    await act(async () => pending.choose(savedElsewhere));
    expect(value("email")).toBe(credentials.email);
    await click("Back to sign in");
    await settle();
    expect(value("password")).toBe("");
    expect(pending.requests).toBe(1);
  });

  it("keeps the typed sign-in when a saved one is chosen after submitting", async () => {
    const pending = await renderPendingOffer((path) =>
      path.endsWith("/sign-in/email")
        ? Response.json({ twoFactorRedirect: true })
        : Response.json({ token: "token", user: {} }),
    );
    await signIn();
    await act(async () => pending.choose(savedElsewhere));
    await submit({ "#two-factor-code": "123456" });
    expect(authenticated).toBe(1);
    expect(offered).toEqual([[credentials.email, credentials.password]]);
  });
});
