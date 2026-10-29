import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type { ApiKey } from "@balebase/validators/apiKeys";
import { act } from "react";
import { installDom } from "./testing/dom";

const {
  click,
  fill,
  mount,
  queryButton,
  respond,
  settle,
  window: dom,
} = installDom({ url: "http://localhost:5173/organization/api-keys" });
const copied: string[] = [];
let OrganizationApiKeys: typeof import("./OrganizationApiKeys").OrganizationApiKeys;
let container: HTMLElement;
let clipboardFails = false;

beforeAll(async () => {
  Object.defineProperty(dom.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (clipboardFails) throw new Error("Clipboard unavailable");
        copied.push(text);
      },
    },
  });
  ({ OrganizationApiKeys } = await import("./OrganizationApiKeys"));
});

afterEach(() => {
  copied.length = 0;
  clipboardFails = false;
});

function apiKey(overrides: Partial<ApiKey>): ApiKey {
  return {
    access: "read",
    createdAt: "2026-10-01T09:00:00.000Z",
    createdBy: { email: "olivia@example.com", id: "user-1", name: "Olivia" },
    expiresAt: "2099-01-01T00:00:00.000Z",
    id: "key-1",
    lastUsedAt: null,
    name: "Reporting",
    prefix: "tlk_1234abcd",
    revokedAt: null,
    revokedBy: null,
    status: "active",
    ...overrides,
  };
}

const token = `tlk_${"a".repeat(64)}`;
const serverUrl = "http://localhost:8787/mcp";

/** Serves the key list and records writes. */
function stubApi(initial: ApiKey[], options: { failList?: boolean } = {}) {
  const requests: Array<{ body: unknown; method: string; path: string }> = [];
  let keys = [...initial];
  respond(async (url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      if (options.failList) {
        return Response.json(
          { error: "Keys are unavailable." },
          { status: 500 },
        );
      }
      return Response.json({ apiKeys: keys });
    }
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ body, method, path: url.pathname });
    if (method === "POST") {
      const created = apiKey({ access: "write", id: "key-2", name: "Claude" });
      keys = [created, ...keys];
      return Response.json({ apiKey: created, token }, { status: 201 });
    }
    const revoked = {
      ...(keys.find(({ id }) => url.pathname.endsWith(id)) ?? apiKey({})),
      revokedAt: "2026-10-16T09:00:00.000Z",
      revokedBy: { email: "olivia@example.com", id: "user-1", name: "Olivia" },
      status: "revoked" as const,
    };
    return Response.json({ apiKey: revoked });
  });
  return requests;
}

async function render() {
  ({ container } = await mount(
    <>
      <OrganizationApiKeys organizationId="org-1" />
      <DialogHost />
    </>,
  ));
  await settle();
}

describe("organization API keys", () => {
  it("lists keys with their access, prefix, and usage", async () => {
    stubApi([
      apiKey({ lastUsedAt: "2026-10-15T12:00:00.000Z" }),
      apiKey({
        access: "write",
        id: "key-old",
        name: "Old",
        status: "inactive",
      }),
    ]);
    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("1 active key");
    expect(text).toContain("Reporting");
    expect(text).toContain("Read only");
    expect(text).toContain("tlk_1234abcd…");
    expect(text).toContain("Created by Olivia");
    expect(text).toContain("Last used");
    expect(text).toContain("Inactive");
    expect(text).toContain("Read and write");
    expect(text).toContain("http://localhost:8787/mcp");
  });

  it("creates a key, shows it once, and returns to the form", async () => {
    const requests = stubApi([]);
    await render();
    expect(container.textContent).toContain("No API keys yet");

    await fill(container.querySelector('input[type="text"]'), " Claude ");
    const [access, expiration] = [...container.querySelectorAll("select")];
    await fill(access ?? null, "write");
    await fill(expiration ?? null, "never");
    await click(queryButton("Create API key", container));

    expect(requests).toEqual([
      {
        body: { access: "write", expiresInDays: null, name: "Claude" },
        method: "POST",
        path: "/api/organization-settings/api-keys",
      },
    ]);
    const secret = container.querySelector<HTMLInputElement>(
      'input[aria-label="API key"]',
    );
    expect(secret?.value).toBe(token);
    expect(container.textContent).toContain(
      "Account, billing, and key management stay session-only.",
    );
    expect(container.textContent).toContain(
      `claude mcp add --transport http balebase http://localhost:8787/mcp --header "Authorization: Bearer ${token}"`,
    );
    await click(queryButton("Copy key", container));
    expect(copied).toEqual([token]);
    expect(container.textContent).toContain("API key copied.");

    await click(queryButton("Copy command", container));
    expect(copied.at(-1)).toBe(
      `claude mcp add --transport http balebase ${serverUrl} --header "Authorization: Bearer ${token}"`,
    );
    await click(queryButton("Codex", container));
    await click(queryButton("Copy configuration", container));
    expect(Bun.TOML.parse(copied.at(-1) ?? "")).toEqual({
      mcp_servers: {
        balebase: {
          url: serverUrl,
          http_headers: { Authorization: `Bearer ${token}` },
        },
      },
    });
    await click(queryButton("Generic", container));
    await click(queryButton("Copy header", container));
    expect(copied.at(-1)).toBe(`Authorization: Bearer ${token}`);

    await click(queryButton("Done", container));
    expect(container.querySelector('input[aria-label="API key"]')).toBeNull();
    expect(container.textContent).not.toContain(token);
    expect(queryButton("Create API key", container)).toBeTruthy();
    expect(container.textContent).toContain("1 active key");
    await click(queryButton("Copy command", container));
    expect(copied.at(-1)).toContain("Bearer YOUR_API_KEY");
    expect(copied.at(-1)).not.toContain(token);
    await click(queryButton("Codex", container));
    expect(container.textContent).not.toContain(token);
    await click(queryButton("Generic", container));
    expect(container.textContent).not.toContain(token);
  });

  it("copies setup templates for existing keys in every client tab", async () => {
    const requests = stubApi([apiKey({})]);
    await render();
    expect(container.textContent).toContain("Replace YOUR_API_KEY");
    expect(container.textContent).toContain(
      "Existing key secrets cannot be shown again.",
    );
    await click(queryButton("Copy command", container));
    expect(copied.at(-1)).toBe(
      `claude mcp add --transport http balebase ${serverUrl} --header "Authorization: Bearer YOUR_API_KEY"`,
    );
    expect(container.textContent).toContain("Copied to clipboard.");

    await click(queryButton("Codex", container));
    expect(queryButton("Codex", container)?.getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(container.textContent).toContain("~/.codex/config.toml");
    expect(container.textContent).not.toContain("Copied to clipboard.");
    await click(queryButton("Copy configuration", container));
    expect(Bun.TOML.parse(copied.at(-1) ?? "")).toEqual({
      mcp_servers: {
        balebase: {
          url: serverUrl,
          http_headers: { Authorization: "Bearer YOUR_API_KEY" },
        },
      },
    });

    await click(queryButton("Generic", container));
    expect(container.textContent).toContain("Streamable HTTP");
    await click(queryButton("Copy server URL", container));
    expect(copied.at(-1)).toBe(serverUrl);
    await click(queryButton("Copy header", container));
    expect(copied.at(-1)).toBe("Authorization: Bearer YOUR_API_KEY");
    expect(copied.join("\n")).not.toContain("tlk_1234abcd");
    expect(requests).toEqual([]);
  });

  it("supports keyboard navigation between configuration tabs", async () => {
    stubApi([apiKey({})]);
    await render();
    queryButton("Claude Code", container)?.focus();
    const moves = [
      ["ArrowRight", "Codex"],
      ["End", "Generic"],
      ["ArrowRight", "Claude Code"],
      ["ArrowLeft", "Generic"],
      ["Home", "Claude Code"],
      ["a", "Claude Code"],
    ] as const;
    for (const [key, label] of moves) {
      await act(async () => {
        document.activeElement?.dispatchEvent(
          new dom.KeyboardEvent("keydown", { bubbles: true, key }) as never,
        );
      });
      const selected = queryButton(label, container);
      expect(document.activeElement).toBe(selected);
      expect(selected?.getAttribute("aria-selected")).toBe("true");
      expect(selected?.tabIndex).toBe(0);
      expect(
        container
          .querySelector('[role="tabpanel"]')
          ?.getAttribute("aria-labelledby"),
      ).toBe(selected?.id);
      expect(
        container.querySelectorAll('[role="tab"][tabindex="0"]').length,
      ).toBe(1);
    }
  });

  it("keeps configuration selectable when copying fails", async () => {
    stubApi([apiKey({})]);
    await render();
    clipboardFails = true;
    await click(queryButton("Codex", container));
    const configuration = container.querySelector("pre")?.textContent;
    await click(queryButton("Copy configuration", container));
    expect(container.textContent).toContain(
      "Copy failed. Select it and copy manually.",
    );
    expect(container.querySelector("pre")?.textContent).toBe(configuration);
    expect(copied).toEqual([]);
  });

  it("revokes a key after confirmation", async () => {
    const requests = stubApi([apiKey({})]);
    await render();

    await click(queryButton("Revoke", container));
    expect(document.querySelector("dialog[open]")?.textContent).toContain(
      "Revoke Reporting?",
    );
    await click(
      queryButton("Revoke key", document.querySelector("dialog[open]")),
    );
    expect(requests).toEqual([
      {
        body: null,
        method: "DELETE",
        path: "/api/organization-settings/api-keys/key-1",
      },
    ]);
    expect(container.textContent).toContain("Revoked");
    expect(container.textContent).toContain("0 active keys");
    expect(queryButton("Revoke", container)).toBeNull();
  });

  it("offers a retry when keys cannot be loaded", async () => {
    stubApi([], { failList: true });
    await render();
    expect(container.textContent).toContain("Keys are unavailable.");
    expect(queryButton("Try again", container)).toBeTruthy();
  });
});
