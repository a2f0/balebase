import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { installDom } from "../testing/dom";
import { useAccountSessions } from "./accountSessions";
import { reloadThemePreference } from "./theme";

const { mount, respond } = installDom({
  globals: (window) => ({ localStorage: window.localStorage }),
  url: "http://localhost:5173/projects",
});

// Later files start from an empty device and the system theme.
afterEach(() => {
  localStorage.clear();
  reloadThemePreference();
});

const session = {
  session: { token: "token-1" },
  user: { email: "dan@example.com", id: "user-1", name: "Dan" },
};

/** What the person chose on this device, as each setting stores it. */
const settings = {
  "balebase.finance-hide-empty-categories": "true",
  "balebase.form-template-view": "grid",
  "balebase.sidebar-width": "320",
  "balebase.theme": "dark",
};

/** Device state that is not a setting, which sign-out leaves to its owners. */
const kept = {
  "balebase.plaid.linkToken": "link-token",
  "balebase.plaid.pendingRepairs": "[]",
  "unrelated.key": "value",
};

type AccountSessions = ReturnType<typeof useAccountSessions>;

/** Hands the test the hook's latest actions. */
function Probe({
  onRender,
}: {
  onRender: (sessions: AccountSessions) => void;
}) {
  onRender(useAccountSessions(session, async () => undefined));
  return null;
}

function stored(keys: Record<string, string>) {
  return Object.fromEntries(
    Object.keys(keys).map((key) => [key, localStorage.getItem(key)]),
  );
}

async function signOut(revoke: () => Response) {
  const requests: string[] = [];
  respond(({ pathname }) => {
    requests.push(pathname);
    if (pathname.endsWith("/multi-session/revoke")) return revoke();
    return Response.json([]);
  });
  localStorage.clear();
  for (const [key, value] of Object.entries({ ...settings, ...kept }))
    localStorage.setItem(key, value);
  reloadThemePreference();
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

  let accounts: AccountSessions | undefined;
  await mount(
    <Probe
      onRender={(rendered) => {
        accounts = rendered;
      }}
    />,
  );
  // A real promise, so a refusal can be awaited and asserted.
  const result = (async () =>
    act(async () => accounts?.signOutActiveAccount()))();
  return { requests, result };
}

describe("signing out", () => {
  it("clears this device's display settings and nothing else", async () => {
    const { requests, result } = await signOut(() =>
      Response.json({ status: true }),
    );
    await result;

    expect(requests).toContain("/api/auth/multi-session/revoke");
    expect(stored(settings)).toEqual(
      Object.fromEntries(Object.keys(settings).map((key) => [key, null])),
    );
    expect(stored(kept)).toEqual(kept);
    // The sign-in page follows the system scheme again (light here).
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("clears them too when the device falls back to a plain sign-out", async () => {
    const { requests, result } = await signOut(() =>
      Response.json(
        { code: "INVALID_SESSION_TOKEN", message: "Invalid session token" },
        { status: 401 },
      ),
    );
    await result;

    expect(requests).toContain("/api/auth/sign-out");
    expect(stored(settings)).toEqual(
      Object.fromEntries(Object.keys(settings).map((key) => [key, null])),
    );
    expect(stored(kept)).toEqual(kept);
  });

  it("keeps the settings when the sign-out is refused", async () => {
    const { result } = await signOut(() =>
      Response.json({ message: "Try again." }, { status: 500 }),
    );
    await expect(result).rejects.toThrow();

    expect(stored(settings)).toEqual(settings);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
