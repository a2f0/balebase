import { describe, expect, it } from "bun:test";
import { installDom } from "../testing/dom";
import { OrganizationPaidFeatures } from "./OrganizationPaidFeatures";

const { click, mount, respond, settle } = installDom({
  url: "http://localhost:5173/organization",
});

function toggle(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('[role="switch"]');
  if (!input) throw new Error("Missing paid features switch");
  return input;
}

describe("organization paid features", () => {
  it("loads the saved choice, persists it, refreshes access, and survives reload", async () => {
    let enabled = true;
    const events: string[] = [];
    const save = Promise.withResolvers<void>();
    respond(async (url, init) => {
      expect(url.pathname).toBe("/api/organization-settings/current");
      if (init?.method === "PATCH") {
        events.push("save");
        await save.promise;
        enabled = JSON.parse(String(init.body)).paidFeaturesEnabled;
      }
      return Response.json({ paidFeaturesEnabled: enabled });
    });
    const card = () => (
      <OrganizationPaidFeatures
        canManage={true}
        onAccessChanged={async () => {
          events.push("refresh");
        }}
      />
    );
    const view = await mount(card());
    expect(toggle(view.container).checked).toBe(true);
    expect(view.container.textContent).toContain(
      "Background checks and Finance",
    );
    expect(view.container.textContent).toContain("cancel subscriptions");
    await click(toggle(view.container));
    expect(toggle(view.container).disabled).toBe(true);
    expect(events).toEqual(["save"]);
    save.resolve();
    await settle();
    expect(events).toEqual(["save", "refresh"]);
    expect(toggle(view.container).checked).toBe(false);
    await view.unmount();
    const reloaded = await mount(card());
    expect(toggle(reloaded.container).checked).toBe(false);
  });

  it("fails closed while loading and offers a retry on load error", async () => {
    const answer = Promise.withResolvers<Response>();
    respond(() => answer.promise);
    const view = await mount(
      <OrganizationPaidFeatures
        canManage={true}
        onAccessChanged={async () => {}}
      />,
    );
    expect(toggle(view.container).disabled).toBe(true);
    expect(toggle(view.container).checked).toBe(false);
    answer.resolve(
      Response.json({ error: "Settings unavailable" }, { status: 503 }),
    );
    await settle();
    expect(view.container.textContent).toContain("Settings unavailable");
    expect(toggle(view.container).disabled).toBe(true);
    respond(() => Response.json({ paidFeaturesEnabled: true }));
    const retry = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    if (!retry) throw new Error("Missing retry");
    await click(retry);
    expect(toggle(view.container).checked).toBe(true);
    expect(toggle(view.container).disabled).toBe(false);
  });

  it("keeps the saved setting when saving fails", async () => {
    let refreshes = 0;
    respond((_url, init) =>
      init?.method === "PATCH"
        ? Response.json({ error: "Could not save" }, { status: 500 })
        : Response.json({ paidFeaturesEnabled: true }),
    );
    const view = await mount(
      <OrganizationPaidFeatures
        canManage={true}
        onAccessChanged={async () => {
          refreshes += 1;
        }}
      />,
    );
    await click(toggle(view.container));
    expect(toggle(view.container).checked).toBe(true);
    expect(view.container.textContent).toContain("Could not save");
    expect(refreshes).toBe(0);
  });

  it("keeps a successful save when refreshing workspace access fails", async () => {
    let enabled = true;
    respond((_url, init) => {
      if (init?.method === "PATCH") {
        enabled = JSON.parse(String(init.body)).paidFeaturesEnabled;
      }
      return Response.json({ paidFeaturesEnabled: enabled });
    });
    const view = await mount(
      <OrganizationPaidFeatures
        canManage={true}
        onAccessChanged={async () => {
          throw new Error("Access unavailable");
        }}
      />,
    );
    await click(toggle(view.container));
    expect(enabled).toBe(false);
    expect(toggle(view.container).checked).toBe(false);
    expect(view.container.textContent).toContain("Paid features saved");
    expect(view.container.textContent).toContain("Reload the page");
  });

  it("shows members the saved setting without permitting changes", async () => {
    const methods: string[] = [];
    respond((_url, init) => {
      methods.push(init?.method ?? "GET");
      return Response.json({ paidFeaturesEnabled: true });
    });
    const view = await mount(
      <OrganizationPaidFeatures
        canManage={false}
        onAccessChanged={async () => {}}
      />,
    );
    expect(toggle(view.container).checked).toBe(true);
    expect(toggle(view.container).disabled).toBe(true);
    await click(toggle(view.container));
    expect(methods).toEqual(["GET"]);
    expect(view.container.textContent).toContain(
      "Only organization owners and admins",
    );
  });

  it("ignores a save completed after switching organizations", async () => {
    const save = Promise.withResolvers<Response>();
    let refreshes = 0;
    respond((_url, init) =>
      init?.method === "PATCH"
        ? save.promise
        : Response.json({ paidFeaturesEnabled: true }),
    );
    const view = await mount(
      <OrganizationPaidFeatures
        key="first"
        canManage={true}
        onAccessChanged={async () => {
          refreshes += 1;
        }}
      />,
    );
    await click(toggle(view.container));
    await view.render(
      <OrganizationPaidFeatures
        key="second"
        canManage={true}
        onAccessChanged={async () => {
          refreshes += 1;
        }}
      />,
    );
    save.resolve(Response.json({ paidFeaturesEnabled: false }));
    await settle();
    expect(toggle(view.container).checked).toBe(true);
    expect(refreshes).toBe(0);
  });
});
