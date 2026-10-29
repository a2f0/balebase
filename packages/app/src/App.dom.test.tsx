import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test";
import { act } from "react";
import { holdTimers, installDom } from "./testing/dom";

// Mounts the real app on an emailed reset link, so the session refreshes
// around the reset and the sign-in after it run exactly as in the browser.
const resetLink = "/reset-password?token=reset-token";
// Better Auth's session store detaches from window a second (nanostores'
// unmount delay) after its last listener leaves. Hold that second and let it
// pass once the last test unmounts: these hooks, registered before
// installDom's, run before the window closes.
let storeUnmounts: ReturnType<typeof holdTimers>;
beforeAll(() => {
  storeUnmounts = holdTimers(1_000);
});
afterAll(async () => {
  await storeUnmounts.fire();
  storeUnmounts.restore();
});
const {
  button,
  fill: fillField,
  mount,
  respond,
  window: dom,
} = installDom({ url: `http://localhost:5173${resetLink}` });
let App: typeof import("./App").App;
let authClient: typeof import("./shared/authClient").authClient;
let container: HTMLElement;

beforeAll(async () => {
  ({ App } = await import("./App"));
  ({ authClient } = await import("./shared/authClient"));
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
 * password revokes only that account's sessions. With `offlineAfterReset` or
 * `offlineAfterSignIn`, the session can no longer be fetched once the reset or
 * sign-in lands, until `reconnect()`.
 */
function stubAuth(
  signedIn: Person | null,
  resetFor: Person,
  { offlineAfterReset = false, offlineAfterSignIn = false } = {},
) {
  let active = signedIn;
  let offline = false;
  respond(async ({ pathname: path }, init) => {
    if (path === "/api/auth/get-session") {
      if (offline) throw new TypeError("Failed to fetch");
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
      offline = offlineAfterReset;
      return Response.json({ status: true });
    }
    if (path === "/api/auth/sign-in/email") {
      const { email } = JSON.parse(String(init?.body));
      active =
        Object.values(people).find((person) => person.email === email) ?? null;
      offline = offlineAfterSignIn;
      return Response.json({ redirect: false, token: "token", user: active });
    }
    return Response.json([]);
  });
  return {
    reconnect() {
      offline = false;
    },
  };
}

async function settle() {
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Opens a path in a fresh mount of the app. */
async function open(path: string) {
  window.history.replaceState(null, "", path);
  // The session store outlives a mount; fetch this browser's session afresh.
  authClient.$store.notify("$sessionSignal");
  ({ container } = await mount(<App />));
  await settle();
}

/** Opens the reset link in a fresh mount of the app. */
async function openResetLink() {
  await open(resetLink);
  expect(heading()).toBe("Choose a new password");
}

const heading = () => container.querySelector("h1")?.textContent;

async function fill(name: string, value: string) {
  await fillField(
    container.querySelector<HTMLInputElement>(`input[name="${name}"]`),
    value,
  );
}

async function press(label: string) {
  await act(async () => button(label).click());
  await settle();
}

async function resetPassword() {
  await fill("password", "correct horse battery");
  await fill("password-confirmation", "correct horse battery");
  await press("Set new password");
  expect(window.location.search).toBe("");
  expect(container.textContent).toContain(
    "Password updated. Sign in with your new password.",
  );
}

async function signIn(person: Person, label: string) {
  await fill("email", person.email);
  await fill("password", "correct horse battery");
  await press(label);
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

  it("leaves the reset link when going back to sign in instead", async () => {
    stubAuth(null, people.owner);
    await openResetLink();

    await press("Back to sign in");
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    expect(heading()).toBe("Enter your workspace");

    await signIn(people.owner, "Sign in");
  });

  it("adds an account when a signed-in browser goes back to sign in", async () => {
    stubAuth(people.other, people.owner);
    await openResetLink();

    await press("Back to sign in");
    expect(window.location.pathname).toBe("/add-account");
    expect(heading()).toBe("Sign in to another account");

    await signIn(people.owner, "Add account");
  });

  it("reports a lost connection after a reset as a session error, not a failed reset", async () => {
    const network = stubAuth(people.owner, people.owner, {
      offlineAfterReset: true,
    });
    await openResetLink();

    await fill("password", "correct horse battery");
    await fill("password-confirmation", "correct horse battery");
    await press("Set new password");
    expect(window.location.pathname).toBe("/");
    expect(container.textContent).not.toContain("Failed to fetch");
    expect(heading()).not.toBe("Choose a new password");
    expect(container.textContent).toContain("We couldn’t load your session.");

    network.reconnect();
    await press("Try again");
    expect(heading()).toBe("Enter your workspace");
  });
});

describe("signing in", () => {
  it("reports a session that fails to load once signed in", async () => {
    const network = stubAuth(null, people.owner, { offlineAfterSignIn: true });
    await open("/");

    await fill("email", people.owner.email);
    await fill("password", "correct horse battery");
    await press("Sign in");
    expect(container.textContent).toContain("We couldn’t load your session.");

    network.reconnect();
    await press("Try again");
    expect(container.querySelector(".authShell")).toBeNull();
  });
});

describe("two-factor sign-in", () => {
  it("keeps the code prompt when returning to the app refetches the session", async () => {
    let sessionRequests = 0;
    let sessionAvailable = true;
    respond(async ({ pathname: path }) => {
      if (path === "/api/auth/get-session") {
        sessionRequests += 1;
        if (!sessionAvailable) throw new TypeError("Failed to fetch");
        return Response.json(null);
      }
      if (path === "/api/auth/sign-in/email") {
        return Response.json({ twoFactorRedirect: true });
      }
      return Response.json([]);
    });
    await open("/");
    expect(heading()).toBe("Enter your workspace");

    await fill("email", people.owner.email);
    await fill("password", "correct horse battery");
    await press("Sign in");
    expect(heading()).toBe("Confirm it’s you");

    // Coming back from the authenticator app makes the page visible again,
    // and Better Auth refetches the session, still empty until the code.
    const before = sessionRequests;
    await act(async () => {
      document.dispatchEvent(new dom.Event("visibilitychange") as never);
    });
    await settle();
    expect(sessionRequests).toBe(before + 1);
    expect(heading()).toBe("Confirm it’s you");

    // So does a later return whose refetch fails as the network wakes up;
    // Better Auth refetches on focus at most every five seconds.
    sessionAvailable = false;
    setSystemTime(new Date(Date.now() + 6_000));
    try {
      await act(async () => {
        document.dispatchEvent(new dom.Event("visibilitychange") as never);
      });
      await settle();
    } finally {
      setSystemTime();
    }
    expect(sessionRequests).toBe(before + 2);
    expect(heading()).toBe("Confirm it’s you");
    expect(container.textContent).not.toContain(
      "We couldn’t load your session.",
    );
  });
});
