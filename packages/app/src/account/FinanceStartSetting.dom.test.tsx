import { describe, expect, it } from "bun:test";
import type { FinancePeriod } from "@balebase/validators/accountSettings";
import { installDom } from "../testing/dom";
import { FinanceStartSetting } from "./FinanceStartSetting";

const { click, fill, mount, respond, settle } = installDom({
  url: "http://localhost:5173/account",
});

/** The first switch (uncategorized), or the one labeled `label`. */
function toggle(container: HTMLElement, label?: string) {
  const input = [
    ...container.querySelectorAll<HTMLInputElement>('[role="switch"]'),
  ].find((item) => !label || item.parentElement?.textContent === label);
  if (!input) throw new Error("No switch");
  return input;
}

describe("Finance start setting", () => {
  it("saves the choice, then reloads the session that carries it", async () => {
    const events: string[] = [];
    const save = Promise.withResolvers<void>();
    respond(async (url, init) => {
      events.push(`${init?.method} ${url.pathname} ${init?.body}`);
      await save.promise;
      return Response.json({ uncategorized: true });
    });
    let on = false;
    const view = await mount(<span />);
    const render = () =>
      view.render(
        <FinanceStartSetting
          opensByPayee={false}
          opensPeriod="allTime"
          opensUncategorized={on}
          onSessionChanged={async () => {
            events.push("session");
            on = true;
            await render();
          }}
        />,
      );
    await render();
    expect(toggle(view.container).checked).toBe(false);
    await click(toggle(view.container));
    // The new choice shows at once, and holds still while it saves.
    expect(toggle(view.container).checked).toBe(true);
    expect(toggle(view.container).disabled).toBe(true);
    save.resolve();
    await settle();
    expect(events).toEqual([
      'PATCH /api/account-settings/finance-start {"uncategorized":true}',
      "session",
    ]);
    expect(toggle(view.container).checked).toBe(true);
    expect(toggle(view.container).disabled).toBe(false);
    expect(toggle(view.container).getAttribute("aria-checked")).toBe("true");
  });

  it("leaves the session alone when the account changes before the save lands", async () => {
    const save = Promise.withResolvers<void>();
    respond(async () => {
      await save.promise;
      return Response.json({ uncategorized: true });
    });
    let refreshed = 0;
    const view = await mount(
      <FinanceStartSetting
        opensByPayee={false}
        opensPeriod="allTime"
        opensUncategorized={false}
        onSessionChanged={async () => {
          refreshed++;
        }}
      />,
    );
    await click(toggle(view.container));
    // Opening another account replaces the page.
    await view.unmount();
    save.resolve();
    await settle();
    expect(refreshed).toBe(0);
  });

  it("shows the saved choice again when saving fails", async () => {
    respond(async () =>
      Response.json({ error: "Could not save." }, { status: 500 }),
    );
    let refreshed = false;
    const { container } = await mount(
      <FinanceStartSetting
        opensByPayee={false}
        opensPeriod="allTime"
        opensUncategorized={false}
        onSessionChanged={async () => {
          refreshed = true;
        }}
      />,
    );
    await click(toggle(container));
    expect(toggle(container).checked).toBe(false);
    expect(container.textContent).toContain("Could not save.");
    expect(refreshed).toBe(false);
  });

  it("saves grouping by payee on its own, beside the other switch", async () => {
    const events: string[] = [];
    respond(async (url, init) => {
      events.push(`${init?.method} ${url.pathname} ${init?.body}`);
      return Response.json({ byPayee: true });
    });
    let byPayee = false;
    const view = await mount(<span />);
    const render = () =>
      view.render(
        <FinanceStartSetting
          opensByPayee={byPayee}
          opensPeriod="allTime"
          opensUncategorized={true}
          onSessionChanged={async () => {
            events.push("session");
            byPayee = true;
            await render();
          }}
        />,
      );
    await render();
    const payees = () =>
      toggle(view.container, "Open Finance on transactions grouped by payee");
    expect(payees().checked).toBe(false);
    expect(toggle(view.container).checked).toBe(true);
    await click(payees());
    await settle();
    expect(events).toEqual([
      'PATCH /api/account-settings/finance-view {"byPayee":true}',
      "session",
    ]);
    expect(payees().checked).toBe(true);
    expect(toggle(view.container).checked).toBe(true);
  });

  it("saves the period chosen from the list, beside the switches", async () => {
    const events: string[] = [];
    const save = Promise.withResolvers<void>();
    respond(async (url, init) => {
      events.push(`${init?.method} ${url.pathname} ${init?.body}`);
      await save.promise;
      return Response.json({ period: "previousYear" });
    });
    let period: FinancePeriod = "allTime";
    const view = await mount(<span />);
    const render = () =>
      view.render(
        <FinanceStartSetting
          opensByPayee={false}
          opensPeriod={period}
          opensUncategorized={false}
          onSessionChanged={async () => {
            events.push("session");
            period = "previousYear";
            await render();
          }}
        />,
      );
    await render();
    const select = () => {
      const found = view.container.querySelector("select");
      if (!found) throw new Error("No period list");
      return found;
    };
    expect(
      [...select().options].map(({ text, value }) => [value, text]),
    ).toEqual([
      ["currentYear", "Current year"],
      ["previousYear", "Previous year"],
      ["allTime", "All time"],
    ]);
    expect(select().value).toBe("allTime");
    await fill(select(), "previousYear");
    // The new choice shows at once, and holds still while it saves.
    expect(select().value).toBe("previousYear");
    expect(select().disabled).toBe(true);
    save.resolve();
    await settle();
    expect(events).toEqual([
      'PATCH /api/account-settings/finance-period {"period":"previousYear"}',
      "session",
    ]);
    expect(select().value).toBe("previousYear");
    expect(select().disabled).toBe(false);
    expect(toggle(view.container).checked).toBe(false);
  });

  it("shows the saved period again when saving it fails", async () => {
    respond(async () =>
      Response.json({ error: "Could not save." }, { status: 500 }),
    );
    const { container } = await mount(
      <FinanceStartSetting
        opensByPayee={false}
        opensPeriod="currentYear"
        opensUncategorized={false}
        onSessionChanged={async () => undefined}
      />,
    );
    const select = container.querySelector("select");
    if (!select) throw new Error("No period list");
    await fill(select, "allTime");
    expect(select.value).toBe("currentYear");
    expect(container.textContent).toContain("Could not save.");
  });
});
