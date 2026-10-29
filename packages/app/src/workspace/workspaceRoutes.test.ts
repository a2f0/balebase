import { describe, expect, it } from "bun:test";
import { isValidElement, type ReactElement } from "react";
import { Audits } from "../Audits";
import { Finance } from "../Finance";
import { FinanceAccountPage } from "../FinanceAccountPage";
import { FinanceConnectionPage } from "../FinanceConnectionPage";
import { FinanceTransactionPage } from "../FinanceTransactionPage";
import { Issues } from "../Issues";
import { MyDocuments } from "../MyDocuments";
import { workspaceRoute } from "./workspaceRoutes";

type RouteContext = Parameters<ReturnType<typeof workspaceRoute>["render"]>[0];

const navigate = (_pathname: string) => undefined;
const library = "library";

function rendered(pathname: string) {
  const context = {
    access: { can: () => false },
    library,
    navigate,
    pathname,
    workspace: {
      activeOrganizationId: "org-2",
      organizations: [{ id: "org-1" }, { id: "org-2" }],
    },
  } as unknown as RouteContext;
  return workspaceRoute(pathname).render(context);
}

function element(pathname: string) {
  const node = rendered(pathname);
  if (!isValidElement(node)) throw new Error(`${pathname} rendered no element`);
  return node as ReactElement<{
    id?: string;
    onNavigate?: unknown;
    organization?: unknown;
    pathname?: string;
  }>;
}

describe("workspace routes", () => {
  it("marks the sidebar entry for each section and the pages beneath it", () => {
    const pages = {
      "/": "library",
      "/account": "account",
      "/account/security": "account",
      "/activity": "activity",
      "/audits": "audits",
      "/audits/runs/run-1": "audits",
      "/businesses/business-1": "businesses",
      "/contracts/templates/template-1": "contracts",
      "/equipment": "equipment",
      "/finance/accounts/account-1": "finance",
      "/inbox": "inbox",
      "/invite": "organization",
      "/issues/new": "issues",
      "/library/folder-1": "library",
      "/me/screening/check-1": "myDocuments",
      "/offline": "offline",
      "/organization/people/member-1": "organization",
      "/root/global-audits/form-1": "rootGlobalAudits",
      "/root/jobs": "rootJobs",
      "/root/organizations/org-1": "rootOrganizations",
      "/root/users": "rootUsers",
    };
    for (const [pathname, page] of Object.entries(pages)) {
      expect([pathname, workspaceRoute(pathname).page]).toEqual([
        pathname,
        page,
      ]);
    }
  });

  it("opens the library for lookalike and unknown paths", () => {
    for (const pathname of [
      "/activity/old",
      "/equipments",
      "/inbox/archived",
      "/media",
      "/root/other",
      "/unknown",
    ]) {
      expect(workspaceRoute(pathname).page).toBe("library");
    }
  });

  it("opens each finance record page with its decoded ID", () => {
    const pages = [
      ["/finance/accounts/a%2Fb", FinanceAccountPage, "a/b"],
      ["/finance/connections/c%20d", FinanceConnectionPage, "c d"],
      ["/finance/transactions/t-1/", FinanceTransactionPage, "t-1"],
    ] as const;
    for (const [pathname, page, id] of pages) {
      const node = element(pathname);
      expect(node.type).toBe(page);
      expect(node.props.id).toBe(id);
      expect(node.props.onNavigate).toBe(navigate);
      // Keyed so each record starts from its own state.
      expect(node.key).toBe(pathname);
    }
  });

  it("shows the finance overview for finance paths that name no record", () => {
    for (const pathname of [
      "/finance",
      "/finance/reports",
      "/finance/accounts",
      "/finance/accounts/a/b",
    ]) {
      const node = element(pathname);
      expect(node.type).toBe(Finance);
      expect(node.props.pathname).toBe(pathname);
    }
  });

  it("passes the path and shell context to the page it renders", () => {
    const issues = element("/issues/issue-1");
    expect(issues.type).toBe(Issues);
    expect(issues.props).toMatchObject({
      canAccessFinance: false,
      onNavigate: navigate,
      pathname: "/issues/issue-1",
    });
    expect(element("/audits/runs/run-1").type).toBe(Audits);
    expect(element("/me").props.organization).toEqual({ id: "org-2" });
    expect(element("/me").type).toBe(MyDocuments);
  });

  it("shows the library node for the library and offline paths", () => {
    for (const pathname of ["/", "/library/folder-1", "/offline", "/unknown"]) {
      expect(rendered(pathname)).toBe(library);
    }
  });
});
