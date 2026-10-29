import { describe, expect, it } from "bun:test";
import { act } from "react";
import { version as appVersion } from "../../package.json";
import { fetchApi } from "../apiVersion";
import { installDom } from "../testing/dom";
import { AccountControl } from "./AccountControl";

const { mount, respond } = installDom({ url: "http://localhost:5173/" });
let container: HTMLElement;

async function respondWith(version: string | null) {
  respond(async () =>
    Response.json(
      { ok: true },
      { headers: version === null ? {} : { "API-Version": version } },
    ),
  );
  await act(async () => {
    await fetchApi("http://localhost:8787/health");
  });
}

describe("app versions", () => {
  it("shows the app version and the API version its latest response named", async () => {
    ({ container } = await mount(
      <AccountControl
        accounts={[]}
        activeSessionToken="session"
        loadError={undefined}
        onAddAccount={() => undefined}
        onRefreshAccounts={async () => undefined}
        onSettings={() => undefined}
        onSignOut={async () => undefined}
        onSwitchAccount={async () => undefined}
        user={{ email: "pat@example.com", name: "Pat Person" }}
      />,
    ));
    await respondWith("9.9.1");
    const trigger = container.querySelector<HTMLButtonElement>(
      "button[aria-haspopup]",
    );
    if (!trigger) throw new Error("No account menu trigger.");
    await act(async () => trigger.click());
    const versions = () => container.querySelector(".menuMeta")?.textContent;

    expect(versions()).toBe(`App v${appVersion} · API v9.9.1`);

    await respondWith(null);
    expect(versions()).toBe(`App v${appVersion} · API v9.9.1`);

    await respondWith("9.9.2");
    expect(versions()).toBe(`App v${appVersion} · API v9.9.2`);
  });
});
