import { describe, expect, it } from "bun:test";
import type { FinanceTransaction } from "@balebase/validators/finance";
import {
  searchTransactions,
  selectFinanceAccount,
  sortTransactions,
} from "./financeTransactions";

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

describe("finance account selection", () => {
  it("focuses one account on an ordinary click and clears a sole selection", () => {
    expect(selectFinanceAccount([], "checking", false)).toEqual(["checking"]);
    expect(
      selectFinanceAccount(["checking", "savings"], "checking", false),
    ).toEqual(["checking"]);
    expect(selectFinanceAccount(["checking"], "checking", false)).toEqual([]);
  });

  it("adds and removes individual accounts with Shift without changing the others", () => {
    expect(selectFinanceAccount([], "savings", true)).toEqual(["savings"]);
    expect(selectFinanceAccount(["checking"], "savings", true)).toEqual([
      "checking",
      "savings",
    ]);
    expect(
      selectFinanceAccount(["checking", "savings", "card"], "savings", true),
    ).toEqual(["checking", "card"]);
    expect(selectFinanceAccount(["checking"], "checking", true)).toEqual([]);
  });
});

describe("transaction search", () => {
  it("matches substrings of displayed payees and original bank descriptions, ignoring case", () => {
    const rows = [
      transaction("cafe", {
        merchantName: "ÉSPRESSO Café",
        name: "CARD PURCHASE 123",
      }),
      transaction("bank", { name: "LOCAL CAFÉ 456" }),
      transaction("other", { merchantName: "Market", name: "GROCER 789" }),
    ];
    expect(searchTransactions(rows, "éSpRe").map(({ id }) => id)).toEqual([
      "cafe",
    ]);
    expect(searchTransactions(rows, "CAFÉ").map(({ id }) => id)).toEqual([
      "cafe",
      "bank",
    ]);
    expect(searchTransactions(rows, "purchase 12").map(({ id }) => id)).toEqual(
      ["cafe"],
    );
    expect(searchTransactions(rows, "missing")).toEqual([]);
  });

  it("treats punctuation and whitespace literally and leaves empty queries unchanged", () => {
    const rows = [
      transaction("literal", { name: "Shop*?[x]." }),
      transaction("plain", { name: "ShopABCxZ" }),
    ];
    for (const query of ["*", "?", "[x]", "."]) {
      expect(searchTransactions(rows, query).map(({ id }) => id)).toEqual([
        "literal",
      ]);
    }
    expect(searchTransactions(rows, " Shop")).toEqual([]);
    expect(searchTransactions(rows, "")).toEqual(rows);
  });
});

describe("transaction sorting", () => {
  const rows = [
    transaction("e", { name: "aLPHA", transactionDate: "2026-01-02" }),
    transaction("b", { name: "beta" }),
    transaction("c", {
      merchantName: "ALPHA",
      name: "ZZZ BANK DESCRIPTION",
      transactionDate: "2026-01-03",
    }),
    transaction("z", { name: "ÉCLAIR", transactionDate: "2026-01-02" }),
    transaction("d", { name: "alpha", transactionDate: "2026-01-03" }),
    transaction("y", { name: "éclair", transactionDate: "2026-01-03" }),
  ];

  it("preserves the newest-first date and descending ID order", () => {
    expect(sortTransactions(rows, "newest").map(({ id }) => id)).toEqual([
      "y",
      "d",
      "c",
      "z",
      "e",
      "b",
    ]);
  });

  it("sorts displayed names case-insensitively in both directions with newest-first ties", () => {
    expect(sortTransactions(rows, "payee").map(({ id }) => id)).toEqual([
      "d",
      "c",
      "e",
      "b",
      "y",
      "z",
    ]);
    expect(sortTransactions(rows, "-payee").map(({ id }) => id)).toEqual([
      "y",
      "z",
      "b",
      "d",
      "c",
      "e",
    ]);
  });

  it("does not mutate the cached array or transaction records", () => {
    const cached = rows.map((row) => Object.freeze({ ...row }));
    const original = [...cached];
    Object.freeze(cached);
    searchTransactions(cached, "alpha");
    sortTransactions(cached, "newest");
    sortTransactions(cached, "payee");
    sortTransactions(cached, "-payee");
    expect(cached).toEqual(original);
  });
});
