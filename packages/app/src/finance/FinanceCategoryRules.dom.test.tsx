import { describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type {
  CategorizationRule,
  ExpenseCategory,
} from "@balebase/validators/finance";
import { installDom } from "../testing/dom";
import { FinanceCategories } from "./FinanceCategories";

const { click, fill, mount, queryButton, respond, settle, window } = installDom(
  { url: "http://localhost:5173/finance/categories" },
);

const categories: ExpenseCategory[] = [
  { id: "fuel", name: "Fuel", slug: "fuel", transactionCount: 0 },
  { id: "meals", name: "Meals", slug: "meals", transactionCount: 0 },
];

function rule(overrides: Partial<CategorizationRule> = {}): CategorizationRule {
  return {
    category: { id: "fuel", name: "Fuel" },
    createdAt: "2026-11-05T12:00:00.000Z",
    id: "rule-1",
    payeeName: "Shell",
    uncategorizedCount: 0,
    ...overrides,
  };
}

/** Serves the rule list (refused when `status` is set) and records writes. */
function stubApi(initial: CategorizationRule[], status?: number) {
  const writes: Array<{ body: unknown; method: string; path: string }> = [];
  let rules = [...initial];
  respond(async (url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return status
        ? Response.json({ error: "Access ended." }, { status })
        : Response.json({ rules });
    }
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    writes.push({ body, method, path: url.pathname });
    if (method === "DELETE") {
      rules = [];
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/apply")) {
      rules = rules.map((item) => ({ ...item, uncategorizedCount: 0 }));
      return Response.json({ applied: 3 });
    }
    const created = rule({ id: "rule-2", payeeName: "Cafe" });
    rules = [...rules, created];
    return Response.json({ applied: 2, rule: created }, { status: 201 });
  });
  return writes;
}

async function render() {
  const calls = { changed: 0, refused: 0 };
  const { container } = await mount(
    <>
      <FinanceCategories
        categories={categories}
        onChanged={async () => {
          calls.changed++;
        }}
        onRefused={async () => {
          calls.refused++;
        }}
        onShowTransactions={() => undefined}
      />
      <DialogHost />
    </>,
  );
  await settle();
  return { calls, container };
}

function ruleRows(container: HTMLElement) {
  return [
    ...container.querySelectorAll('[aria-label="Categorization rules"] li'),
  ].map((row) => row.textContent);
}

describe("categorization rules", () => {
  it("adds a rule that also fills the payee's uncategorized transactions", async () => {
    const writes = stubApi([rule({ uncategorizedCount: 0 })]);
    const { calls, container } = await render();
    expect(ruleRows(container)).toEqual([expect.stringContaining("Shell")]);
    const payeeField = container.querySelector<HTMLInputElement>(
      'input[placeholder="Shell"]',
    );
    await fill(payeeField, "Cafe");
    await fill(container.querySelector("select"), "meals");
    await click(queryButton("Add rule", container));
    expect(writes).toEqual([
      {
        body: { applyToExisting: true, categoryId: "meals", payeeName: "Cafe" },
        method: "POST",
        path: "/api/finance/categorization-rules",
      },
    ]);
    expect(container.textContent).toContain(
      "Added a rule for “Cafe” and categorized 2 transactions.",
    );
    expect(ruleRows(container)).toHaveLength(2);
    expect(payeeField?.value).toBe("");
    expect(calls.changed).toBe(1);
  });

  it("adds a rule for future imports only when the box is cleared", async () => {
    const writes = stubApi([]);
    const { container } = await render();
    expect(container.textContent).toContain("No categorization rules yet");
    await fill(
      container.querySelector<HTMLInputElement>('input[placeholder="Shell"]'),
      "Cafe",
    );
    await fill(container.querySelector("select"), "fuel");
    await click(
      container.querySelector<HTMLInputElement>('input[type="checkbox"]'),
    );
    await click(queryButton("Add rule", container));
    expect(writes[0]?.body).toEqual({
      applyToExisting: false,
      categoryId: "fuel",
      payeeName: "Cafe",
    });
    expect(container.textContent).toContain("Added a rule for “Cafe”.");
  });

  it("fills the payee a transaction's menu sent, once", async () => {
    stubApi([]);
    window.history.replaceState(
      null,
      "",
      "/finance/categories?payee=Shell+%26+Co",
    );
    const { container } = await render();
    expect(
      container.querySelector<HTMLInputElement>('input[placeholder="Shell"]')
        ?.value,
    ).toBe("Shell & Co");
    expect(window.location.search).toBe("");
  });

  it("applies a rule to what is left, and deletes it after confirming", async () => {
    const writes = stubApi([rule({ uncategorizedCount: 3 })]);
    const { calls, container } = await render();
    expect(ruleRows(container)[0]).toContain("3 uncategorized transactions");
    await click(queryButton("Categorize 3", container));
    expect(writes.at(-1)).toEqual({
      body: null,
      method: "POST",
      path: "/api/finance/categorization-rules/rule-1/apply",
    });
    expect(container.textContent).toContain(
      "Categorized 3 transactions from “Shell”.",
    );
    expect(queryButton("Categorize 3", container)).toBeNull();
    await click(queryButton("Delete the rule for Shell", container));
    await click(queryButton("Delete rule", document));
    expect(writes.at(-1)).toEqual({
      body: null,
      method: "DELETE",
      path: "/api/finance/categorization-rules/rule-1",
    });
    expect(container.textContent).toContain("No categorization rules yet");
    expect(calls.changed).toBe(2);
  });

  it("forgets Finance when loading the rules finds access gone", async () => {
    stubApi([], 403);
    const { calls } = await render();
    expect(calls.refused).toBe(1);
  });
});
