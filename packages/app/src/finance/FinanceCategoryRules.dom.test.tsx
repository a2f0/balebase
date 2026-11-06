import { describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type {
  CategorizationRule,
  ExpenseCategory,
} from "@balebase/validators/finance";
import { installDom } from "../testing/dom";
import { FinanceRules } from "./FinanceRules";

const { click, fill, mount, queryButton, respond, settle, window } = installDom(
  { url: "http://localhost:5173/finance/rules" },
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
    owner: { id: "user-1", name: "Dan Sullivan" },
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
    if (method === "PATCH") {
      const edit = body as { categoryId: string; payeeName: string };
      const category = categories.find(({ id }) => id === edit.categoryId);
      rules = rules.map((item) => ({
        ...item,
        category: { id: edit.categoryId, name: category?.name ?? "" },
        payeeName: edit.payeeName,
        uncategorizedCount: 2,
      }));
      return Response.json({ rule: rules[0] });
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

function page(
  calls: { changed: number; navigated: string[]; refused: number },
  shown: ExpenseCategory[] | undefined,
) {
  return (
    <>
      <FinanceRules
        categories={shown}
        onChanged={async () => {
          calls.changed++;
        }}
        onNavigate={(path) => {
          calls.navigated.push(path);
        }}
        onRefused={async () => {
          calls.refused++;
        }}
      />
      <DialogHost />
    </>
  );
}

async function render() {
  const calls = { changed: 0, navigated: [] as string[], refused: 0 };
  const view = await mount(page(calls, categories));
  await settle();
  return {
    calls,
    container: view.container,
    rerender: async (shown: ExpenseCategory[] | undefined) => {
      await view.render(page(calls, shown));
      await settle();
    },
    unmount: view.unmount,
  };
}

function ruleRows(container: HTMLElement) {
  return [
    ...container.querySelectorAll('[aria-label="Categorization rules"] li'),
  ].map((row) => row.textContent);
}

async function openMenu(container: HTMLElement, payee: string) {
  await click(queryButton(`Actions for the rule for ${payee}`, container));
}

function menuItems() {
  return [...document.querySelectorAll('[role="menuitem"]')].map(
    (item) => item.textContent,
  );
}

/** Opens a rule's menu from its menu button and chooses `label`. */
async function chooseFromMenu(
  container: HTMLElement,
  payee: string,
  label: string,
) {
  await openMenu(container, payee);
  const item = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((element) => element.textContent === label);
  if (!item) throw new Error(`Missing menu item: ${label}`);
  await click(item);
}

describe("categorization rules", () => {
  it("edits a rule's payee and category from its menu", async () => {
    const writes = stubApi([rule({ uncategorizedCount: 0 })]);
    const { calls, container } = await render();
    await openMenu(container, "Shell");
    expect(menuItems()).toEqual(["Edit", "Delete"]);
    await chooseFromMenu(container, "Shell", "Edit");
    const form = container.querySelector<HTMLFormElement>(
      '[aria-label="Edit the rule for Shell"]',
    );
    if (!form) throw new Error("No edit form");
    const payee = form.querySelector("input");
    expect(document.activeElement).toBe(payee);
    // Unchanged, there is nothing to save.
    expect(queryButton("Save", form)?.disabled).toBe(true);
    await fill(payee, "Chevron");
    await fill(form.querySelector("select"), "meals");
    await click(queryButton("Save", form));
    expect(writes).toEqual([
      {
        body: { categoryId: "meals", payeeName: "Chevron" },
        method: "PATCH",
        path: "/api/finance/categorization-rules/rule-1",
      },
    ]);
    expect(container.textContent).toContain("Saved the rule for “Chevron”.");
    expect(
      container.querySelector('[aria-label="Edit the rule for Shell"]'),
    ).toBeNull();
    expect(ruleRows(container)).toEqual([expect.stringContaining("Chevron")]);
    expect(ruleRows(container)[0]).toContain("Meals · 2 uncategorized");
    expect(ruleRows(container)[0]).toContain("Created by Dan Sullivan");
    // Focus returns to the menu button that opened the editor.
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Actions for the rule for Chevron",
    );
    expect(calls.changed).toBe(1);
  });

  it("keeps the edit open with its values when saving fails, and cancels", async () => {
    stubApi([rule()]);
    respond(async (_url, init) =>
      init?.method === "PATCH"
        ? Response.json(
            { error: "That payee already has a rule." },
            { status: 409 },
          )
        : Response.json({ rules: [rule()] }),
    );
    const { container } = await render();
    await chooseFromMenu(container, "Shell", "Edit");
    const form = container.querySelector<HTMLFormElement>(
      '[aria-label="Edit the rule for Shell"]',
    );
    if (!form) throw new Error("No edit form");
    await fill(form.querySelector("input"), "Chevron");
    await click(queryButton("Save", form));
    expect(container.textContent).toContain("That payee already has a rule.");
    expect(form.querySelector("input")?.value).toBe("Chevron");
    await click(queryButton("Cancel", form));
    expect(ruleRows(container)).toEqual([expect.stringContaining("Shell")]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Actions for the rule for Shell",
    );
  });

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

  it("holds the form still while a rule saves, then clears what it sent", async () => {
    const held = Promise.withResolvers<Response>();
    respond(async (_url, init) =>
      (init?.method ?? "GET") === "GET"
        ? Response.json({ rules: [] })
        : held.promise,
    );
    const { container } = await render();
    const payee = container.querySelector<HTMLInputElement>(
      'input[placeholder="Shell"]',
    );
    await fill(payee, "Cafe");
    await fill(container.querySelector("select"), "meals");
    await click(queryButton("Add rule", container));
    const fields = [
      payee,
      container.querySelector("select"),
      container.querySelector('input[type="checkbox"]'),
    ];
    expect(fields.map((field) => field?.hasAttribute("disabled"))).toEqual([
      true,
      true,
      true,
    ]);
    held.resolve(
      Response.json(
        { applied: 0, rule: rule({ id: "rule-2", payeeName: "Cafe" }) },
        { status: 201 },
      ),
    );
    await settle();
    expect(payee?.value).toBe("");
    expect(payee?.hasAttribute("disabled")).toBe(false);
  });

  it("points to Categories when there is no category to choose", async () => {
    stubApi([]);
    const { calls, container, rerender } = await render();
    await rerender([]);
    expect(container.textContent).toContain("Add an expense category first");
    expect(queryButton("Add rule", container)).toBeNull();
    await click(queryButton("Open categories", container));
    expect(calls.navigated).toEqual(["/finance/categories"]);
  });

  it("fills the payee a transaction's menu sent, once", async () => {
    stubApi([]);
    window.history.replaceState(null, "", "/finance/rules?payee=Shell+%26+Co");
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
    await chooseFromMenu(container, "Shell", "Categorize 3 transactions");
    expect(writes.at(-1)).toEqual({
      body: null,
      method: "POST",
      path: "/api/finance/categorization-rules/rule-1/apply",
    });
    expect(container.textContent).toContain(
      "Categorized 3 transactions from “Shell”.",
    );
    await openMenu(container, "Shell");
    expect(menuItems()).toEqual(["Edit", "Delete"]);
    await chooseFromMenu(container, "Shell", "Delete");
    await click(queryButton("Delete rule", document));
    expect(writes.at(-1)).toEqual({
      body: null,
      method: "DELETE",
      path: "/api/finance/categorization-rules/rule-1",
    });
    expect(container.textContent).toContain("No categorization rules yet");
    expect(calls.changed).toBe(2);
  });

  it("reports no refusal that arrives after the rules are gone", async () => {
    const held = Promise.withResolvers<Response>();
    respond(() => held.promise);
    const { calls, unmount } = await render();
    await unmount();
    held.resolve(Response.json({ error: "Access ended." }, { status: 403 }));
    await settle();
    expect(calls.refused).toBe(0);
  });

  it("goes with the categories when access ends, and loads afresh after", async () => {
    let lists = 0;
    respond(() => {
      lists++;
      return Response.json({ rules: [rule()] });
    });
    const { container, rerender } = await render();
    expect(ruleRows(container)).toHaveLength(1);
    await rerender(undefined);
    expect(container.textContent).not.toContain("Categorization rules");
    expect(container.textContent).not.toContain("Shell");
    await rerender(categories);
    expect(ruleRows(container)).toHaveLength(1);
    expect(lists).toBe(2);
  });

  it("reloads the rules when a category is renamed or deleted", async () => {
    let name = "Fuel";
    let lists = 0;
    respond(() => {
      lists++;
      return Response.json({
        rules: [rule({ category: { id: "fuel", name } })],
      });
    });
    const { container, rerender } = await render();
    expect(ruleRows(container)[0]).toContain("Fuel");
    // The same categories again, as an unrelated reload sends them.
    await rerender(categories.map((category) => ({ ...category })));
    expect(lists).toBe(1);
    name = "Gas";
    await rerender([{ ...categories[0], name: "Gas" } as ExpenseCategory]);
    expect(lists).toBe(2);
    expect(ruleRows(container)[0]).toContain("Gas");
  });

  it("forgets Finance when loading the rules finds access gone", async () => {
    stubApi([], 403);
    const { calls } = await render();
    expect(calls.refused).toBe(1);
  });
});
