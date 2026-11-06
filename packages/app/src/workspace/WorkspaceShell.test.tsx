import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceShell } from "./WorkspaceShell";

function navigationGroups(
  role: string,
  finance: { canAccessFinance: boolean; opensUncategorized?: boolean } = {
    canAccessFinance: false,
  },
) {
  const markup = renderToStaticMarkup(
    <WorkspaceShell
      accountLoadError={undefined}
      accounts={[]}
      activeOrganizationId={undefined}
      activePage="organization"
      activeSessionToken=""
      canAccessFinance={finance.canAccessFinance}
      contentKey={undefined}
      onAccountChange={async () => undefined}
      onAccountSettings={() => undefined}
      onAddAccount={() => undefined}
      onNavigate={() => undefined}
      onOrganizationChange={async () => undefined}
      onOrganizationCreate={async () => undefined}
      onRefreshAccounts={async () => undefined}
      onSignOut={async () => undefined}
      organizations={[]}
      user={{
        email: "user@example.com",
        emailVerified: true,
        financeOpensUncategorized: finance.opensUncategorized,
        name: "User",
        role,
      }}
    >
      <span>Workspace content</span>
    </WorkspaceShell>,
  );
  return [...markup.matchAll(/<div class="navGroup">([\s\S]*?)<\/div>/g)].map(
    (match) => match[1],
  );
}

describe("workspace navigation", () => {
  it("opens Finance where the person chose, and only with Finance access", () => {
    const financeLink = (finance: Parameters<typeof navigationGroups>[1]) =>
      navigationGroups("user", finance)
        .join("")
        .match(/href="(\/finance[^"]*)"/)?.[1];
    expect(financeLink({ canAccessFinance: false })).toBeUndefined();
    expect(financeLink({ canAccessFinance: true })).toBe("/finance");
    expect(
      financeLink({ canAccessFinance: true, opensUncategorized: true }),
    ).toBe("/finance/expenses/category/uncategorized");
  });

  it("shows Organization in Admin without showing Root Admin to a regular user", () => {
    const groups = navigationGroups("user");
    expect(groups.some((group) => group?.includes('href="/issues"'))).toBe(
      true,
    );
    const admin = groups.find((group) => group?.includes(">Admin</p>"));

    expect(admin).toContain('href="/organization"');
    expect(groups.some((group) => group?.includes(">Root Admin</p>"))).toBe(
      false,
    );
  });

  it("keeps root-only Users separate from Organization", () => {
    const groups = navigationGroups("admin");
    const admin = groups.find((group) => group?.includes(">Admin</p>"));
    const rootAdmin = groups.find((group) =>
      group?.includes(">Root Admin</p>"),
    );

    expect(admin).toContain('href="/organization"');
    expect(admin).not.toContain('href="/root/users"');
    expect(admin).not.toContain('href="/root/organizations"');
    expect(admin).not.toContain('href="/root/global-audits"');
    expect(rootAdmin).toContain('href="/root/users"');
    expect(rootAdmin).toContain('href="/root/organizations"');
    expect(rootAdmin).toContain('href="/root/global-audits"');
    expect(rootAdmin).toContain("Global Audits");
    expect(rootAdmin).toContain('href="/root/jobs"');
    expect(rootAdmin).not.toContain('href="/organization"');
    expect(rootAdmin).not.toContain('href="/admin"');
  });
});
