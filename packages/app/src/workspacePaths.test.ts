import { describe, expect, it } from "bun:test";
import {
  adminOrganizationIdForPath,
  adminOrganizationPath,
  auditRunPath,
  auditTemplatePath,
  businessIdForPath,
  businessPath,
  contractIdForPath,
  contractPath,
  contractTemplateIdForPath,
  contractTemplatePath,
  equipmentIdForPath,
  equipmentPath,
  expenseCategoryFiltersFor,
  financeAccountPath,
  financeConnectionPath,
  financeOverviewPath,
  financePageFor,
  globalAuditsPath,
  globalAuditTemplateIdForPath,
  inboxEmailPath,
  isRootAdminPath,
  issuePath,
  isWithin,
  libraryFolderIdForPath,
  libraryPath,
  movedWorkspacePath,
  myDocumentsPath,
  myScreeningIdForPath,
  organizationMemberIdForPath,
  organizationPathRequiresAccess,
  organizationPeoplePath,
  organizationSettingsPage,
  recordIdForPath,
  signingTokenForPath,
  transactionIssuePath,
} from "./workspacePaths";

describe("workspace paths", () => {
  it("matches a section and the pages beneath it, not lookalikes", () => {
    expect(isWithin("/equipment", "/equipment")).toBe(true);
    expect(isWithin("/equipment/abc", "/equipment")).toBe(true);
    expect(isWithin("/equipment/", "/equipment")).toBe(true);
    expect(isWithin("/equipments", "/equipment")).toBe(false);
    expect(isWithin("/media", "/me")).toBe(false);
    expect(isWithin("/", "/me")).toBe(false);
  });

  it("reads one record ID beneath a prefix", () => {
    expect(recordIdForPath("/equipment/item%2F1", "/equipment")).toBe("item/1");
    expect(recordIdForPath("/equipment/abc/", "/equipment")).toBe("abc");
    expect(recordIdForPath("/equipment", "/equipment")).toBeUndefined();
    expect(recordIdForPath("/equipment/", "/equipment")).toBeUndefined();
    expect(recordIdForPath("/equipment/a/b", "/equipment")).toBeUndefined();
    expect(recordIdForPath("/equipments/abc", "/equipment")).toBeUndefined();
    expect(recordIdForPath("/other/abc", "/equipment")).toBeUndefined();
  });

  it("keeps a malformed escape as typed so the page reports it unavailable", () => {
    for (const segment of ["%", "%E0", "%E0%A4%A"]) {
      expect(recordIdForPath(`/equipment/${segment}`, "/equipment")).toBe(
        segment,
      );
    }
    expect(organizationMemberIdForPath("/organization/people/%E0%A4%A")).toBe(
      "%E0%A4%A",
    );
    expect(organizationSettingsPage("/organization/people/%E0%A4%A")).toBe(
      "people",
    );
    expect(globalAuditTemplateIdForPath("/root/global-audits/%")).toBe("%");
    expect(adminOrganizationIdForPath("/root/organizations/%")).toBe("%");
  });

  it("links to audit runs and forms by encoded ID", () => {
    expect(auditRunPath("run/1")).toBe("/audits/runs/run%2F1");
    expect(auditTemplatePath("form 1")).toBe("/audits/templates/form%201");
    expect(recordIdForPath(auditRunPath("run/1"), "/audits/runs")).toBe(
      "run/1",
    );
  });

  it("links to issues by encoded ID", () => {
    expect(issuePath("issue/1")).toBe("/issues/issue%2F1");
    expect(transactionIssuePath("txn/1")).toBe(
      "/issues/new/transactions/txn%2F1",
    );
  });

  it("round-trips My documents paths and moves older screening links", () => {
    expect(myDocumentsPath()).toBe("/me");
    expect(myDocumentsPath("check/1")).toBe("/me/screening/check%2F1");
    expect(myScreeningIdForPath(myDocumentsPath("check/1"))).toBe("check/1");
    expect(myScreeningIdForPath("/me")).toBeUndefined();
    expect(myScreeningIdForPath("/me/screening/%E0%A4%A")).toBe("%E0%A4%A");
    expect(
      movedWorkspacePath("/organization/people/member/screening/check%2F1"),
    ).toBe("/me/screening/check%2F1");
    expect(movedWorkspacePath("/organization/people/member")).toBeUndefined();
    expect(movedWorkspacePath("/me/screening/check")).toBeUndefined();
  });

  it("round-trips business paths", () => {
    expect(businessPath()).toBe("/businesses");
    expect(businessPath("business/1")).toBe("/businesses/business%2F1");
    expect(businessIdForPath(businessPath("business/1"))).toBe("business/1");
    expect(businessIdForPath("/businesses")).toBeUndefined();
  });

  it("round-trips library folder paths", () => {
    expect(libraryPath()).toBe("/");
    expect(libraryPath("folder/1")).toBe("/library/folder%2F1");
    expect(libraryFolderIdForPath(libraryPath("folder/1"))).toBe("folder/1");
    expect(libraryFolderIdForPath("/library/abc/")).toBe("abc");
    expect(libraryFolderIdForPath("/")).toBeUndefined();
    expect(libraryFolderIdForPath("/library")).toBeUndefined();
    expect(libraryFolderIdForPath("/library/a/b")).toBeUndefined();
    expect(libraryFolderIdForPath("/library/%E0%A4")).toBe("%E0%A4");
  });

  it("round-trips equipment paths", () => {
    expect(equipmentPath()).toBe("/equipment");
    expect(equipmentPath("item/1")).toBe("/equipment/item%2F1");
    expect(equipmentIdForPath(equipmentPath("item/1"))).toBe("item/1");
    expect(equipmentIdForPath("/equipment")).toBeUndefined();
    expect(equipmentIdForPath("/equipment/%E0%A4")).toBe("%E0%A4");
  });

  it("round-trips contract paths", () => {
    expect(contractPath()).toBe("/contracts");
    expect(contractPath("contract/1")).toBe("/contracts/contract%2F1");
    expect(contractIdForPath(contractPath("contract/1"))).toBe("contract/1");
    expect(contractIdForPath("/contracts")).toBeUndefined();
    expect(contractIdForPath("/contracts/a/b")).toBeUndefined();
  });

  it("round-trips contract template paths", () => {
    expect(contractTemplatePath()).toBe("/contracts/templates");
    expect(contractTemplateIdForPath(contractTemplatePath("template/1"))).toBe(
      "template/1",
    );
    expect(contractTemplateIdForPath("/contracts/templates")).toBeUndefined();
    expect(contractTemplateIdForPath("/contracts/templates/%E0%A4")).toBe(
      "%E0%A4",
    );
    expect(isWithin(contractTemplatePath("t1"), contractPath())).toBe(true);
  });

  it("recognises public signing links", () => {
    const token = `${"A".repeat(40)}_-9`;
    expect(signingTokenForPath(`/sign/${token}`)).toBe(token);
    expect(signingTokenForPath(`/sign/${token}/`)).toBe(token);
    expect(signingTokenForPath(`/sign/${token}x`)).toBeUndefined();
    expect(signingTokenForPath("/sign/short")).toBeUndefined();
    expect(signingTokenForPath(`/sign/${token}/document`)).toBeUndefined();
  });

  it("opens a message in the inbox", () => {
    expect(inboxEmailPath("email 1")).toBe("/inbox?email=email+1");
    expect(inboxEmailPath("email 1", "archived")).toBe(
      "/inbox?email=email+1&folder=archived",
    );
  });

  it("routes organization settings to focused sub-pages", () => {
    expect(organizationSettingsPage("/organization")).toBe("general");
    expect(organizationSettingsPage("/organization/people")).toBe("people");
    expect(organizationSettingsPage("/organization/people/member%2F1")).toBe(
      "people",
    );
    expect(organizationMemberIdForPath("/organization/people/member%2F1")).toBe(
      "member/1",
    );
    expect(organizationMemberIdForPath("/organization/people")).toBeUndefined();
    expect(organizationPeoplePath("member/1")).toBe(
      "/organization/people/member%2F1",
    );
    expect(organizationSettingsPage("/organization/access")).toBe("access");
    expect(organizationSettingsPage("/organization/api-keys")).toBe("api-keys");
    expect(organizationSettingsPage("/organization/unknown")).toBe("general");
  });

  it("waits for access on every organization-dependent route", () => {
    for (const path of [
      "/",
      "/audits",
      "/businesses",
      "/finance",
      "/inbox",
      "/me",
      "/me/screening/check",
      "/organization",
    ]) {
      expect(organizationPathRequiresAccess(path)).toBeTrue();
    }
    for (const path of [
      "/account/security",
      "/root/users",
      "/root/organizations",
      "/root/organizations/other-organization",
      "/root/global-audits",
      "/root/global-audits/nfpa70e_global",
      "/root/jobs",
      "/invite",
    ]) {
      expect(organizationPathRequiresAccess(path)).toBeFalse();
    }
    expect(organizationPathRequiresAccess("/admin")).toBeTrue();
    expect(isRootAdminPath("/root/jobs")).toBeTrue();
    expect(isRootAdminPath("/root/users")).toBeTrue();
    expect(isRootAdminPath("/root/organizations")).toBeTrue();
    expect(
      isRootAdminPath("/root/organizations/other-organization"),
    ).toBeTrue();
    expect(isRootAdminPath("/root/global-audits")).toBeTrue();
    expect(isRootAdminPath("/root/global-audits/template")).toBeTrue();
    expect(isRootAdminPath("/root/global-auditsx")).toBeFalse();
    expect(isRootAdminPath("/audits/global-templates/template")).toBeFalse();
    expect(isRootAdminPath("/admin")).toBeFalse();
  });

  it("resolves Global Audits form links", () => {
    expect(globalAuditsPath()).toBe("/root/global-audits");
    expect(globalAuditsPath("form/1")).toBe("/root/global-audits/form%2F1");
    expect(globalAuditTemplateIdForPath("/root/global-audits/form%2F1")).toBe(
      "form/1",
    );
    expect(globalAuditTemplateIdForPath("/root/global-audits/form-1/")).toBe(
      "form-1",
    );
    expect(globalAuditTemplateIdForPath("/root/global-audits")).toBeUndefined();
    expect(
      globalAuditTemplateIdForPath("/root/global-audits/form-1/unexpected"),
    ).toBeUndefined();
  });

  it("resolves organization detail links", () => {
    expect(adminOrganizationIdForPath("/root/organizations/org%2F1")).toBe(
      "org/1",
    );
    expect(adminOrganizationIdForPath("/root/organizations/org-1/")).toBe(
      "org-1",
    );
    expect(adminOrganizationIdForPath("/root/organizations")).toBeUndefined();
    expect(adminOrganizationPath("org/1")).toBe("/root/organizations/org%2F1");
    expect(
      adminOrganizationIdForPath("/root/organizations/org-1/unexpected"),
    ).toBeUndefined();
  });

  it("routes finance paths to their tabs", () => {
    expect(financePageFor("/finance")).toBe("overview");
    expect(financePageFor("/finance/reports")).toBe("reports");
    expect(financePageFor("/finance/categories")).toBe("categories");
    expect(financePageFor("/finance/connections")).toBe("connections");
    expect(financePageFor("/finance/unknown")).toBe("overview");
    expect(financePageFor("/finance/expenses/category/meals")).toBe("overview");
  });

  it("links to connection and account pages by raw id", () => {
    expect(financeConnectionPath("item/1")).toBe(
      "/finance/connections/item%2F1",
    );
    expect(financeAccountPath("account/1")).toBe(
      "/finance/accounts/account%2F1",
    );
  });

  it("maps expense category paths to and from their filters", () => {
    const none = { categorySlug: null, uncategorized: false };
    const uncategorized = { categorySlug: null, uncategorized: true };
    const meals = { categorySlug: "meals-2", uncategorized: false };
    expect(financeOverviewPath(none)).toBe("/finance");
    expect(financeOverviewPath(uncategorized)).toBe(
      "/finance/expenses/category/uncategorized",
    );
    expect(financeOverviewPath(meals)).toBe(
      "/finance/expenses/category/meals-2",
    );
    for (const filters of [none, uncategorized, meals]) {
      expect(expenseCategoryFiltersFor(financeOverviewPath(filters))).toEqual(
        filters,
      );
    }
    expect(expenseCategoryFiltersFor("/finance/expenses/category/")).toEqual(
      none,
    );
    expect(
      expenseCategoryFiltersFor("/finance/expenses/category/caf%C3%A9"),
    ).toEqual({ categorySlug: "café", uncategorized: false });
    expect(expenseCategoryFiltersFor("/finance/expenses/category/%E0")).toEqual(
      { categorySlug: "%E0", uncategorized: false },
    );
  });
});
