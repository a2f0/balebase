import { describe, expect, it } from "bun:test";
import type { FinanceTransaction } from "@balebase/validators/finance";
import { groupByPayee } from "./payeeGroups";

const transaction = (
  id: string,
  overrides: Partial<FinanceTransaction> = {},
): FinanceTransaction => ({
  accountId: "checking",
  accountName: "Checking",
  amount: 10,
  annotation: { labels: [], note: "", reviewed: false },
  authorizedDate: null,
  categoryDetailed: null,
  categoryPrimary: null,
  currencyCode: "USD",
  expenseCategoryId: null,
  id,
  linkedEmails: [],
  merchantName: null,
  name: id,
  paymentChannel: null,
  pending: false,
  transactionDate: "2026-01-01",
  ...overrides,
});

describe("payee groups", () => {
  it("groups by the name rows show, most transactions first, then by name", () => {
    const groups = groupByPayee([
      transaction("a", { name: "SHELL OIL 123", merchantName: "Shell" }),
      transaction("b", { name: "Zeta" }),
      transaction("c", { name: "SHELL 99", merchantName: "Shell" }),
      transaction("d", { name: "Alpha" }),
      transaction("e", { name: "Shell" }),
    ]);
    expect(groups.map(({ count, name }) => [name, count])).toEqual([
      ["Shell", 3],
      ["Alpha", 1],
      ["Zeta", 1],
    ]);
  });

  it("sums amounts as rows show them, without float error or negative zero", () => {
    const [fuel, refunded] = groupByPayee([
      transaction("a", { amount: 0.1, merchantName: "Fuel" }),
      transaction("b", { amount: 0.2, merchantName: "Fuel" }),
      transaction("c", { amount: 5, merchantName: "Shop" }),
      transaction("d", { amount: -5, merchantName: "Shop" }),
    ]);
    expect(fuel?.total).toBe(-0.3);
    expect(Object.is(refunded?.total, 0)).toBe(true);
  });

  it("counts pending rows, keeps the latest date, and drops totals across currencies", () => {
    const [group] = groupByPayee([
      transaction("a", { pending: true, transactionDate: "2026-03-01" }),
      transaction("a", { transactionDate: "2026-05-01" }),
      transaction("a", { currencyCode: "CAD", transactionDate: "2026-02-01" }),
    ]);
    expect(group).toEqual({
      count: 3,
      currencyCode: null,
      latestDate: "2026-05-01",
      name: "a",
      pending: 1,
      total: null,
    });
  });
});
