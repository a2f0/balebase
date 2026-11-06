import { describe, expect, it } from "bun:test";
import { installDom } from "../testing/dom";
import { FinanceStartSetting } from "./FinanceStartSetting";

const { click, mount, respond, settle } = installDom({
  url: "http://localhost:5173/account",
});

function toggle(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('[role="switch"]');
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
          on={on}
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
        on={false}
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
        on={false}
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
});
