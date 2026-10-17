import { describe, expect, it } from "bun:test";
import { selectFinanceAccount } from "./financeTransactions";

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
