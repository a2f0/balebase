import { afterEach, describe, expect, it } from "bun:test";
import type { ComponentProps } from "react";
import { installDom } from "../testing/dom";
import { defaultSidebarWidth, sidebarWidthStorageKey } from "./sidebarWidth";
import { WorkspaceShell } from "./WorkspaceShell";

const { mount, window: dom } = installDom({
  globals: (window) => ({ localStorage: window.localStorage }),
  url: "http://localhost:5173/projects",
});

afterEach(() => {
  dom.localStorage.clear();
});

function Shell({ session }: { session: string }) {
  const props: ComponentProps<typeof WorkspaceShell> = {
    accountLoadError: undefined,
    accounts: [],
    activeOrganizationId: undefined,
    activePage: "projects",
    activeSessionToken: session,
    canAccessFinance: false,
    children: <span>Workspace content</span>,
    contentKey: undefined,
    onAccountChange: async () => undefined,
    onAccountSettings: () => undefined,
    onAddAccount: () => undefined,
    onNavigate: () => undefined,
    onOrganizationChange: async () => undefined,
    onOrganizationCreate: async () => undefined,
    onRefreshAccounts: async () => undefined,
    onSignOut: async () => undefined,
    organizations: [],
    user: {
      email: "user@example.com",
      emailVerified: true,
      name: "User",
      role: "user",
    },
  };
  return <WorkspaceShell {...props} />;
}

const width = (container: HTMLElement) =>
  container
    .querySelector<HTMLElement>(".shell")
    ?.style.getPropertyValue("--sidebar-width");

describe("the sidebar's width", () => {
  it("is read afresh for another account, as after a sign-out cleared it", async () => {
    localStorage.setItem(sidebarWidthStorageKey, "320");
    const view = await mount(<Shell session="token-1" />);
    expect(width(view.container)).toBe("320px");

    // A sign-out clears the setting, and the account left signed in takes over.
    localStorage.removeItem(sidebarWidthStorageKey);
    await view.render(<Shell session="token-1" />);
    expect(width(view.container)).toBe("320px");
    await view.render(<Shell session="token-2" />);
    expect(width(view.container)).toBe(`${defaultSidebarWidth}px`);
  });
});
