import { describe, expect, it } from "bun:test";
import { workspaceRoute } from "./workspaceRoutes";

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
});
