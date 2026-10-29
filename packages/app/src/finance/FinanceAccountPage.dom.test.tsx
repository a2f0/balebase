import { describe, expect, it } from "bun:test";
import type { FinanceAccountDetail } from "@balebase/validators/finance";
import { act } from "react";
import { installDom } from "../testing/dom";
import { FinanceAccountPage } from "./FinanceAccountPage";

const { clickLink, mount, respond, settle, stubClipboard } = installDom({
  url: "http://localhost:5173/finance/accounts/account-1",
  globals: (window) => ({
    MouseEvent: window.MouseEvent,
  }),
});
let container: HTMLElement;

const detail: FinanceAccountDetail = {
  account: {
    availableBalance: 1200,
    currencyCode: "USD",
    currentBalance: 1250.5,
    id: "account-1",
    mask: "1234",
    name: "Checking",
    officialName: "Plaid Gold Checking",
    plaidAccountId: "plaid-account-1",
    subtype: "checking",
    transactions: {
      count: 42,
      firstDate: "2025-01-03",
      lastDate: "2026-10-17",
    },
    type: "depository",
    updatedAt: "2026-10-18T12:00:00.000Z",
  },
  connection: {
    dailySync: false,
    id: "item-1",
    institutionId: "ins_109508",
    institutionName: "First Platypus Bank",
    plaidItemId: "plaid-item-1",
    status: "active",
  },
  recentTransactions: [
    {
      amount: 42.75,
      currencyCode: "USD",
      id: "txn-1",
      merchantName: "Test Cafe",
      name: "TEST CAFE 123",
      pending: true,
      transactionDate: "2026-10-17",
    },
    {
      amount: -500,
      currencyCode: "USD",
      id: "txn-2",
      merchantName: null,
      name: "Payroll deposit",
      pending: false,
      transactionDate: "2026-10-15",
    },
  ],
};

async function mountPage(onNavigate: (path: string) => void = () => undefined) {
  ({ container } = await mount(
    <FinanceAccountPage id="account-1" onNavigate={onNavigate} />,
  ));
  await settle();
}

function link(href: string) {
  const match = container.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
  if (!match) throw new Error(`Missing link: ${href}`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => {
    clickLink(element);
  });
}

describe("Finance account page", () => {
  it("updates daily sync on the account's bank connection", async () => {
    let enabled = false;
    respond(async (url, init) => {
      if (init?.method === "PATCH") {
        expect(url.href).toEndWith("/connections/item-1/sync-settings");
        enabled = JSON.parse(String(init.body)).dailySync;
        return Response.json({ dailySync: enabled });
      }
      return Response.json(detail);
    });
    await mountPage();
    expect(container.textContent).toContain("Daily sync");
    const checkbox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!checkbox) throw new Error("Missing daily sync setting");
    await click(checkbox);
    expect(enabled).toBe(true);
    expect(checkbox.checked).toBe(true);
  });
  it("shows the account, its newest transactions, and copyable identifiers", async () => {
    const requests: string[] = [];
    respond(async (url) => {
      requests.push(url.href);
      return Response.json(detail);
    });
    const copied: string[] = [];
    stubClipboard(async (text) => void copied.push(text));
    await mountPage();

    expect(requests).toEqual([
      expect.stringContaining("/api/finance/accounts/account-1"),
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("Checking");
    expect(text).toContain("42 transactions · ");
    expect(text).toContain("Plaid Gold Checking");
    expect(link("/finance/connections/item-1").textContent).toBe(
      "First Platypus Bank",
    );
    expect(link("/finance/transactions/txn-1").textContent).toBe("Test Cafe");
    expect(link("/finance/transactions/txn-2").textContent).toBe(
      "Payroll deposit",
    );
    expect(text).toContain("Pending");
    expect(container.querySelector(".financeAmountCredit")?.textContent).toBe(
      "$500.00",
    );

    const copy = container.querySelector<HTMLButtonElement>(
      '[aria-label="Copy Plaid account ID"]',
    );
    if (!copy) throw new Error("Missing copy button");
    await click(copy);
    expect(copied).toEqual(["plaid-account-1"]);
  });

  it("opens the account's connection and transactions in the app", async () => {
    respond(async () => Response.json(detail));
    const paths: string[] = [];
    await mountPage((path) => paths.push(path));

    await click(link("/finance/transactions/txn-1"));
    await click(link("/finance/connections/item-1"));
    const view = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "View connection",
    );
    if (!view) throw new Error("Missing View connection");
    await click(view);
    expect(paths).toEqual([
      "/finance/transactions/txn-1",
      "/finance/connections/item-1",
      "/finance/connections/item-1",
    ]);
  });

  it("reports an account that cannot be loaded", async () => {
    respond(async () =>
      Response.json({ error: "Account not found." }, { status: 404 }),
    );
    await mountPage();
    expect(container.textContent).toContain("Account not found.");
    expect(container.textContent).not.toContain("Loading account");
  });
});
