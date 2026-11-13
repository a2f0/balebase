import { expect, it } from "bun:test";
import type { ActivityEvent } from "@balebase/validators/activity";
import { categorizedByRule, financeActivitySummary } from "./financeActivity";

function event(
  action: string,
  details: ActivityEvent["details"],
): ActivityEvent {
  return {
    action,
    actor: {
      email: "owner@example.com",
      id: "owner",
      name: "Owner",
      source: null,
      type: "user",
    },
    details,
    historical: false,
    id: 1,
    occurredAt: "2026-11-13T12:00:00.000Z",
    root: { id: "fuel", label: "Fuel", type: "finance_category" },
    subject: { id: "rule", type: "finance_categorization_rule" },
  };
}

// These assert semantic distinctions, not incidental display wording.
it("keeps match-only rule changes distinguishable in history", () => {
  const summary = (matchType: string, previousMatchType: string) =>
    financeActivitySummary(
      event("finance.categorization_rule_updated", {
        categoryName: "Fuel",
        matchType,
        payeeName: "Shell",
        previousCategoryName: "Fuel",
        previousMatchType,
        previousPayeeName: "Shell",
      }),
    );
  expect(summary("contains", "exact")).not.toBe(summary("exact", "contains"));
  expect(summary("contains", "exact")).not.toBe(
    summary("contains", "startsWith"),
  );
  expect(summary("startsWith", "exact")).not.toBe(summary("contains", "exact"));
});

it("interprets pre-mode activity as exact without conflating non-exact rules", () => {
  for (const action of [
    "finance.categorization_rule_created",
    "finance.categorization_rule_applied",
    "finance.categorization_rule_deleted",
  ]) {
    const details = { categoryName: "Fuel", count: 2, payeeName: "Shell" };
    const legacy = financeActivitySummary(event(action, details));
    const exact = financeActivitySummary(
      event(action, { ...details, matchType: "exact" }),
    );
    const starts = financeActivitySummary(
      event(action, { ...details, matchType: "startsWith" }),
    );
    const contains = financeActivitySummary(
      event(action, { ...details, matchType: "contains" }),
    );
    expect(legacy).toBe(exact);
    expect(exact).not.toBe(starts);
    expect(exact).not.toBe(contains);
    expect(starts).not.toBe(contains);
  }
});

it("attributes only a recorded rule and distinguishes its matching semantics", () => {
  const attribution = (details: ActivityEvent["details"]) =>
    categorizedByRule(event("finance.transaction_categorized", details));
  const details = { ruleId: "rule", rulePayeeName: "Shell" };
  expect(
    attribution({ rulePayeeName: "Shell", ruleMatchType: "contains" }),
  ).toBe("");
  expect(attribution(details)).toBe(
    attribution({ ...details, ruleMatchType: "exact" }),
  );
  expect(attribution({ ...details, ruleMatchType: "startsWith" })).not.toBe(
    attribution(details),
  );
  expect(attribution({ ...details, ruleMatchType: "contains" })).not.toBe(
    attribution({ ...details, ruleMatchType: "startsWith" }),
  );
});
