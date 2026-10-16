import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import { apiKeyRouteDenial } from "./apiKeys";
import { app } from "./app";
import { createAuth } from "./auth";
import { mcpTools } from "./mcp";
import { toolAccess, toolInputSchema } from "./mcpToolSchema";
import type { Bindings } from "./types";

interface ApiKey {
  access: "read" | "write";
  createdBy: { email: string };
  expiresAt: string | null;
  id: string;
  lastUsedAt: string | null;
  name: string;
  prefix: string;
  revokedAt: string | null;
  status: "active" | "expired" | "inactive" | "revoked";
}

interface ToolListing {
  tools: Array<{
    annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
    inputSchema: { properties?: Record<string, unknown> };
    name: string;
  }>;
}

const modernVersion = "2026-07-28";

describe("organization API keys", () => {
  it("shows a new key once and lists only its prefix", async () => {
    const fixture = await createFixture();
    const created = await fixture.session<{ apiKey: ApiKey; token: string }>(
      "POST",
      "/api/organization-settings/api-keys",
      { access: "read", expiresInDays: 90, name: " Reporting " },
    );
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^tlk_[0-9a-f]{64}$/);
    expect(created.body.apiKey).toMatchObject({
      access: "read",
      createdBy: { email: fixture.email },
      lastUsedAt: null,
      name: "Reporting",
      prefix: created.body.token.slice(0, 12),
      status: "active",
    });
    const expiresIn =
      Date.parse(created.body.apiKey.expiresAt ?? "") - Date.now();
    expect(Math.round(expiresIn / 86_400_000)).toBe(90);

    const listing = await fixture.session<{ apiKeys: ApiKey[] }>(
      "GET",
      "/api/organization-settings/api-keys",
    );
    expect(listing.body.apiKeys.map(({ id }) => id)).toEqual([
      created.body.apiKey.id,
    ]);
    expect(JSON.stringify(listing.body)).not.toContain(created.body.token);
    const stored = fixture.database
      .query("SELECT token_hash FROM organization_api_keys")
      .get() as { token_hash: string };
    expect(stored.token_hash).not.toContain(created.body.token.slice(4));
  });

  it("validates new keys and limits them to organization managers", async () => {
    const fixture = await createFixture();
    for (const input of [
      { access: "read", expiresInDays: 90, name: "" },
      { access: "read", expiresInDays: 90, name: "x".repeat(101) },
      { access: "admin", expiresInDays: 90, name: "Key" },
      { access: "write", expiresInDays: 7, name: "Key" },
      { access: "write", name: "Key" },
    ]) {
      const response = await fixture.session(
        "POST",
        "/api/organization-settings/api-keys",
        input,
      );
      expect(response.status).toBe(400);
    }
    expect(
      (
        await fixture.session("POST", "/api/organization-settings/api-keys", {
          access: "write",
          expiresInDays: null,
          name: "Forever",
        })
      ).status,
    ).toBe(201);

    fixture.setRole("member");
    for (const [method, body] of [
      ["GET", undefined],
      ["POST", { access: "read", expiresInDays: 30, name: "Key" }],
    ] as const) {
      const response = await fixture.session(
        method,
        "/api/organization-settings/api-keys",
        body,
      );
      expect(response.status).toBe(403);
    }
  });

  it("authenticates REST calls as the creator within the key's organization", async () => {
    const fixture = await createFixture();
    const otherOrganizationId = fixture.joinAnotherOrganization();
    fixture.addEquipment("laptop", fixture.organizationId, "MacBook Pro");
    fixture.addEquipment("monitor", otherOrganizationId, "Studio Display");
    const { token } = await fixture.createKey("write");

    const listing = await fixture.withKey<{
      equipment: Array<{ model: string }>;
    }>(token, "GET", "/api/equipment");
    expect(listing.status).toBe(200);
    expect(listing.body.equipment.map(({ model }) => model)).toEqual([
      "MacBook Pro",
    ]);

    const created = await fixture.withKey<{ equipment: { id: string } }>(
      token,
      "POST",
      "/api/equipment",
      { make: "Apple", model: "iPhone", type: "cell_phone" },
    );
    expect(created.status).toBe(201);
    expect(
      fixture.database
        .query(`SELECT organization_id, created_by FROM equipment WHERE id = ?`)
        .get(created.body.equipment.id),
    ).toEqual({
      created_by: fixture.userId,
      organization_id: fixture.organizationId,
    });

    const identity = await fixture.withKey<{
      apiKey: { access: string; organizationId: string };
      user: { email: string; role: string };
    }>(token, "GET", "/api/me");
    expect(identity.body.apiKey).toMatchObject({
      access: "write",
      organizationId: fixture.organizationId,
    });
    expect(identity.body.user).toMatchObject({
      email: fixture.email,
      role: "user",
    });
  });

  it("keeps read keys read-only and session-only routes closed", async () => {
    const fixture = await createFixture();
    const { token: readToken } = await fixture.createKey("read");
    const { token: writeToken } = await fixture.createKey("write");

    const denied = await fixture.withKey<{ error: string }>(
      readToken,
      "POST",
      "/api/equipment",
      { make: "Apple", model: "iPhone", type: "cell_phone" },
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("This API key is read-only.");
    expect(
      (await fixture.withKey(readToken, "GET", "/api/equipment")).status,
    ).toBe(200);

    for (const [method, path] of [
      ["GET", "/api/organization-settings/api-keys"],
      ["POST", "/api/organization-settings/api-keys"],
      ["GET", "/api/billing"],
      ["GET", "/api/account-settings/deletion"],
      ["GET", "/api/admin/organizations"],
      ["GET", "/api/organization-settings/organizations"],
      ["DELETE", "/api/organization-settings/current"],
      ["GET", "/api/auth/organization/list-members"],
    ] as const) {
      const response = await fixture.withKey<{ error: string }>(
        writeToken,
        method,
        path,
        method === "POST" ? { access: "write", name: "Escalate" } : undefined,
      );
      expect({ path, status: response.status }).toEqual({ path, status: 403 });
    }
    const people = await fixture.withKey<{ error: string }>(
      writeToken,
      "PATCH",
      "/api/organization-settings/people/member-id/two-factor-required",
      { required: false },
    );
    expect(people.status).toBe(403);
    expect(people.body.error).toBe("This endpoint is read-only for API keys.");
  });

  it("rejects unknown, revoked, expired, and orphaned keys", async () => {
    const fixture = await createFixture();
    const unknown = await fixture.withKey<{ error: string }>(
      `tlk_${"0".repeat(64)}`,
      "GET",
      "/api/equipment",
    );
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("WWW-Authenticate")).toContain("invalid_token");
    expect(
      (await fixture.withKey("tlk_malformed", "GET", "/api/equipment")).status,
    ).toBe(401);

    const revoked = await fixture.createKey("read");
    const revocation = await fixture.session<{ apiKey: ApiKey }>(
      "DELETE",
      `/api/organization-settings/api-keys/${revoked.apiKey.id}`,
    );
    expect(revocation.body.apiKey.status).toBe("revoked");
    const afterRevocation = await fixture.withKey<{ error: string }>(
      revoked.token,
      "GET",
      "/api/equipment",
    );
    expect(afterRevocation.status).toBe(401);
    expect(afterRevocation.body.error).toBe("This API key has been revoked.");

    const expired = await fixture.createKey("read");
    fixture.database
      .query("UPDATE organization_api_keys SET expires_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", expired.apiKey.id);
    expect(
      (await fixture.withKey(expired.token, "GET", "/api/equipment")).status,
    ).toBe(401);

    const orphaned = await fixture.createKey("write");
    fixture.setRole("member");
    const inactive = await fixture.withKey<{ error: string }>(
      orphaned.token,
      "GET",
      "/api/equipment",
    );
    expect(inactive.status).toBe(403);
    expect(inactive.body.error).toContain("no longer manages");
    fixture.setRole("owner");
    const statuses = await fixture.session<{ apiKeys: ApiKey[] }>(
      "GET",
      "/api/organization-settings/api-keys",
    );
    expect(statuses.body.apiKeys.map(({ status }) => status).sort()).toEqual([
      "active",
      "expired",
      "revoked",
    ]);
  });

  it("records key use and lifecycle activity", async () => {
    const fixture = await createFixture();
    const { apiKey, token } = await fixture.createKey("read");
    await fixture.withKey(token, "GET", "/api/equipment");
    await Promise.all(fixture.pending);
    const used = fixture.database
      .query("SELECT last_used_at FROM organization_api_keys WHERE id = ?")
      .get(apiKey.id) as { last_used_at: string | null };
    expect(used.last_used_at).not.toBeNull();

    await fixture.session(
      "DELETE",
      `/api/organization-settings/api-keys/${apiKey.id}`,
    );
    const activity = await fixture.session<{
      events: Array<{ action: string; details: { access?: unknown } }>;
    }>("GET", "/api/activity");
    expect(
      activity.body.events
        .filter(({ action }) => action.startsWith("api_key."))
        .map(({ action, details }) => [action, details.access]),
    ).toEqual([
      ["api_key.revoked", "read"],
      ["api_key.created", "read"],
    ]);
  });
});

describe("API key security boundaries", () => {
  it("binds two-factor verification to the session that issued the key", async () => {
    const fixture = await createFixture();
    const unverified = await fixture.createKey("read");
    fixture.database
      .query(`UPDATE user SET twoFactorEnabled = 1 WHERE id = ?`)
      .run(fixture.userId);
    fixture.database
      .query(`UPDATE member SET twoFactorRequired = 1 WHERE userId = ?`)
      .run(fixture.userId);
    const denied = await fixture.withKey<{ code: string }>(
      unverified.token,
      "GET",
      "/api/equipment",
    );
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("TWO_FACTOR_VERIFICATION_REQUIRED");

    fixture.database
      .query(`UPDATE session SET twoFactorVerified = 1 WHERE userId = ?`)
      .run(fixture.userId);
    const verified = await fixture.createKey("read");
    expect(
      fixture.database
        .query(
          "SELECT two_factor_verified FROM organization_api_keys WHERE id = ?",
        )
        .get(verified.apiKey.id),
    ).toEqual({ two_factor_verified: 1 });
    expect(
      (await fixture.withKey(verified.token, "GET", "/api/equipment")).status,
    ).toBe(200);

    fixture.database
      .query(`UPDATE user SET twoFactorEnabled = 0 WHERE id = ?`)
      .run(fixture.userId);
    const disabled = await fixture.withKey<{ code: string }>(
      verified.token,
      "GET",
      "/api/equipment",
    );
    expect(disabled.status).toBe(403);
    expect(disabled.body.code).toBe("TWO_FACTOR_SETUP_REQUIRED");
  });

  it("applies the creator's Free-plan seat", async () => {
    const fixture = await createFixture();
    const { token } = await fixture.createKey("read");
    fixture.database
      .query(
        `INSERT INTO user
         (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
         VALUES ('earlier-owner', 'Earlier', 'earlier@example.com', 1, ?, ?,
                 'user', 0)`,
      )
      .run(now(), now());
    fixture.database
      .query(
        `INSERT INTO member (id, organizationId, userId, role, createdAt)
         VALUES ('earlier-member', ?, 'earlier-owner', 'owner',
                 '2000-01-01T00:00:00.000Z')`,
      )
      .run(fixture.organizationId);
    const response = await fixture.withKey<{ code: string }>(
      token,
      "GET",
      "/api/equipment",
    );
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("UPGRADE_REQUIRED");
  });

  it("requires the creator's Finance group membership", async () => {
    const fixture = await createFixture();
    const { token } = await fixture.createKey("read");
    expect((await fixture.withKey(token, "GET", "/api/finance")).status).toBe(
      200,
    );
    fixture.database
      .query(`DELETE FROM "teamMember" WHERE "userId" = ?`)
      .run(fixture.userId);
    const denied = await fixture.withKey<{ error: string }>(
      token,
      "GET",
      "/api/finance",
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("Finance group membership required.");
  });

  it("rejects keys while their creator is banned", async () => {
    const fixture = await createFixture();
    const { token } = await fixture.createKey("read");
    fixture.database
      .query(`UPDATE user SET banned = 1, banExpires = NULL WHERE id = ?`)
      .run(fixture.userId);
    const banned = await fixture.withKey<{ error: string }>(
      token,
      "GET",
      "/api/equipment",
    );
    expect(banned.status).toBe(403);
    expect(banned.body.error).toBe("This API key's creator is banned.");

    fixture.database
      .query(`UPDATE user SET banExpires = ? WHERE id = ?`)
      .run("2020-01-01T00:00:00.000Z", fixture.userId);
    expect((await fixture.withKey(token, "GET", "/api/equipment")).status).toBe(
      200,
    );
  });

  it("refuses to create keys while impersonating", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `UPDATE session SET impersonatedBy = 'root-admin' WHERE userId = ?`,
      )
      .run(fixture.userId);
    const response = await fixture.session<{ error: string }>(
      "POST",
      "/api/organization-settings/api-keys",
      { access: "write", expiresInDays: 30, name: "Persistent" },
    );
    expect(response.status).toBe(403);
    expect(response.body.error).toContain("impersonating");
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM organization_api_keys")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("limits each organization to 50 active keys", async () => {
    const fixture = await createFixture();
    const insert = fixture.database.query(
      `INSERT INTO organization_api_keys
       (id, organization_id, name, access, token_prefix, token_hash,
        created_by, created_at)
       VALUES (?, ?, 'Seeded', 'read', 'tlk_seeded', ?, ?, ?)`,
    );
    for (let index = 0; index < 50; index += 1) {
      insert.run(
        `seeded-${index}`,
        fixture.organizationId,
        `hash-${index}`,
        fixture.userId,
        now(),
      );
    }
    const input = { access: "read", expiresInDays: 30, name: "One more" };
    const limited = await fixture.session<{ error: string }>(
      "POST",
      "/api/organization-settings/api-keys",
      input,
    );
    expect(limited.status).toBe(409);
    expect(limited.body.error).toContain("at most 50");

    fixture.database
      .query("UPDATE organization_api_keys SET expires_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", "seeded-0");
    expect(
      (
        await fixture.session(
          "POST",
          "/api/organization-settings/api-keys",
          input,
        )
      ).status,
    ).toBe(201);
  });
});

describe("MCP endpoint", () => {
  it("requires an API key and a trusted origin", async () => {
    const fixture = await createFixture();
    const anonymous = await fixture.mcp(undefined, legacyInitialize());
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("WWW-Authenticate")).toContain("Bearer");

    const cookie = await app.request(
      "/mcp",
      {
        body: JSON.stringify(legacyInitialize()),
        headers: { ...mcpHeaders(), cookie: fixture.cookie },
        method: "POST",
      },
      fixture.bindings,
      fixture.executionContext,
    );
    expect(cookie.status).toBe(401);

    const { token } = await fixture.createKey("read");
    const foreign = await fixture.mcp(token, legacyInitialize(), {
      Origin: "https://attacker.example",
    });
    expect(foreign.status).toBe(403);
  });

  it("serves clients that open with initialize", async () => {
    const fixture = await createFixture();
    const { token } = await fixture.createKey("read");
    const initialized = await rpcResult<{
      protocolVersion: string;
      serverInfo: { name: string };
    }>(await fixture.mcp(token, legacyInitialize()));
    expect(initialized.protocolVersion).toBe("2025-06-18");
    expect(initialized.serverInfo.name).toBe("balebase");

    const legacyHeaders = { "MCP-Protocol-Version": "2025-06-18" };
    const notification = await fixture.mcp(
      token,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      legacyHeaders,
    );
    expect(notification.status).toBe(202);

    const listing = await rpcResult<ToolListing>(
      await fixture.mcp(
        token,
        { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
        legacyHeaders,
      ),
    );
    expect(listing.tools.map(({ name }) => name)).toContain("list_equipment");
  });

  it("lists only read tools for read keys", async () => {
    const fixture = await createFixture();
    const read = await fixture.createKey("read");
    const write = await fixture.createKey("write");

    const readTools = await fixture.modernTools(read.token);
    const writeTools = await fixture.modernTools(write.token);
    expect(readTools.tools.length).toBe(
      mcpTools.filter((tool) => toolAccess(tool) === "read").length,
    );
    expect(writeTools.tools.length).toBe(mcpTools.length);
    expect(
      readTools.tools.every(({ annotations }) => annotations?.readOnlyHint),
    ).toBe(true);
    expect(readTools.tools.map(({ name }) => name)).not.toContain(
      "create_equipment",
    );
    const deletion = writeTools.tools.find(
      ({ name }) => name === "delete_equipment",
    );
    expect(deletion?.annotations).toMatchObject({
      destructiveHint: true,
      readOnlyHint: false,
    });
  });

  it("calls REST routes with the key's permissions", async () => {
    const fixture = await createFixture();
    fixture.addEquipment("laptop", fixture.organizationId, "MacBook Pro");
    const read = await fixture.createKey("read");
    const write = await fixture.createKey("write");

    const listed = await fixture.callTool<{ content: Array<{ text: string }> }>(
      read.token,
      "list_equipment",
      {},
    );
    expect(JSON.parse(listed.content[0]?.text ?? "").equipment[0].model).toBe(
      "MacBook Pro",
    );

    const unavailable = await rpcMessage(
      await fixture.mcp(
        read.token,
        modernRequest("tools/call", {
          arguments: { make: "Apple", model: "iPhone", type: "cell_phone" },
          name: "create_equipment",
        }),
        { "Mcp-Method": "tools/call", "Mcp-Name": "create_equipment" },
      ),
    );
    expect(unavailable.error).toMatchObject({
      message: "Tool create_equipment not found",
    });
    expect(
      fixture.database.query("SELECT COUNT(*) AS count FROM equipment").get(),
    ).toEqual({ count: 1 });

    const created = await fixture.callTool<{
      content: Array<{ text: string }>;
      isError?: boolean;
    }>(write.token, "create_equipment", {
      make: "Apple",
      model: "iPhone",
      type: "cell_phone",
    });
    expect(created.isError).toBeUndefined();
    const { equipment } = JSON.parse(created.content[0]?.text ?? "");

    const rejected = await fixture.callTool<{
      content: Array<{ text: string }>;
      isError?: boolean;
    }>(write.token, "update_equipment", { id: equipment.id, type: "tablet" });
    expect(rejected.isError).toBe(true);

    const invalid = await fixture.callTool<{
      content: Array<{ text: string }>;
      isError?: boolean;
    }>(write.token, "update_equipment", {
      id: equipment.id,
      purchaseDate: "2026-02-30",
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]?.text).toContain("status 400");

    const deleted = await fixture.callTool<{
      content: Array<{ text: string }>;
    }>(write.token, "delete_equipment", { id: equipment.id });
    expect(deleted.content[0]?.text).toBe("Done.");
  });

  it("summarizes audit forms without their full definitions", async () => {
    const fixture = await createFixture();
    const { token } = await fixture.createKey("read");
    const result = await fixture.callTool<{ content: Array<{ text: string }> }>(
      token,
      "list_audit_templates",
      {},
    );
    const { templates } = JSON.parse(result.content[0]?.text ?? "") as {
      templates: Array<{ definition?: unknown; questionCount?: number }>;
    };
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      expect(template).not.toHaveProperty("definition");
      expect(template.questionCount).toBeGreaterThan(0);
    }
  });
});

describe("MCP tool catalog", () => {
  it("names each tool once and declares every argument", () => {
    const names = mcpTools.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of mcpTools) {
      expect(tool.name).toMatch(/^[a-z][a-z_]{2,63}$/);
      const placeholders = [...tool.path.matchAll(/\{(\w+)\}/g)].map(
        (match) => match[1] ?? "",
      );
      expect(Object.keys(tool.params ?? {}).sort()).toEqual(
        placeholders.sort(),
      );
      const argumentNames = [
        ...Object.keys(tool.params ?? {}),
        ...Object.keys(tool.query ?? {}),
        ...Object.keys(tool.body?.properties ?? {}),
      ];
      expect(new Set(argumentNames).size).toBe(argumentNames.length);
      for (const required of tool.body?.required ?? []) {
        expect(Object.keys(tool.body?.properties ?? {})).toContain(required);
      }
      expect(toolInputSchema(tool)).toMatchObject({ type: "object" });
    }
  });

  it("only offers routes the key's access level can call", () => {
    for (const tool of mcpTools) {
      const path = tool.path.replace(/\{\w+\}/g, "id");
      expect({
        denial: apiKeyRouteDenial(path, tool.method, toolAccess(tool)),
        tool: tool.name,
      }).toEqual({ denial: undefined, tool: tool.name });
    }
  });
});

async function createFixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const directory = `${import.meta.dir}/../migrations`;
  for (const filename of (await readdir(directory)).sort()) {
    database.exec(await Bun.file(`${directory}/${filename}`).text());
  }
  const bindings = testBindings(database);
  const pending: Promise<unknown>[] = [];
  const executionContext = {
    passThroughOnException: () => undefined,
    props: {},
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } as unknown as ExecutionContext;
  const auth = createAuth(bindings, (promise) => pending.push(promise));
  const email = "owner@example.com";
  const password = "correct horse battery staple";
  const authRequest = (path: string, body: Record<string, unknown>) =>
    auth.handler(
      new Request(`https://api.test/api/auth${path}`, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          origin: "https://app.test",
        },
        method: "POST",
      }),
    );
  await authRequest("/sign-up/email", {
    email,
    name: "Owner Person",
    password,
    termsAccepted: true,
  });
  await Promise.all(pending);
  const signIn = await authRequest("/sign-in/email", { email, password });
  const cookie = signIn.headers.get("set-cookie") ?? "";
  const { organizationId, userId } = database
    .query(
      `SELECT member.organizationId, user.id AS userId
       FROM member JOIN user ON user.id = member.userId WHERE user.email = ?`,
    )
    .get(email) as { organizationId: string; userId: string };

  async function send<T>(
    path: string,
    method: string,
    headers: Record<string, string>,
    body?: unknown,
  ) {
    const init: RequestInit = { headers, method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { ...headers, "content-type": "application/json" };
    }
    const response = await app.request(path, init, bindings, executionContext);
    const text = await response.text();
    return {
      body: (text ? JSON.parse(text) : null) as T,
      headers: response.headers,
      status: response.status,
    };
  }

  const fixture = {
    bindings,
    cookie,
    database,
    email,
    executionContext,
    organizationId,
    pending,
    userId,
    addEquipment(id: string, organization: string, model: string) {
      database
        .query(
          `INSERT INTO equipment
           (id, organization_id, type, make, model, created_at, updated_at)
           VALUES (?, ?, 'computer', 'Apple', ?, ?, ?)`,
        )
        .run(id, organization, model, now(), now());
    },
    async callTool<T>(token: string, name: string, args: unknown) {
      return rpcResult<T>(
        await fixture.mcp(
          token,
          modernRequest("tools/call", { arguments: args, name }),
          { "Mcp-Method": "tools/call", "Mcp-Name": name },
        ),
      );
    },
    async createKey(access: "read" | "write") {
      const created = await fixture.session<{ apiKey: ApiKey; token: string }>(
        "POST",
        "/api/organization-settings/api-keys",
        { access, expiresInDays: 30, name: `${access} key` },
      );
      expect(created.status).toBe(201);
      return created.body;
    },
    /** Adds a second organization and makes it the user's default. */
    joinAnotherOrganization() {
      const otherId = "other-organization";
      database
        .query(
          `INSERT INTO organization (id, name, slug, createdAt)
           VALUES (?, 'Other', 'other', ?)`,
        )
        .run(otherId, now());
      database
        .query(
          `INSERT INTO member (id, organizationId, userId, role, createdAt)
           VALUES ('other-member', ?, ?, 'owner', ?)`,
        )
        .run(otherId, userId, now());
      database
        .query(`UPDATE user SET defaultOrganizationId = ? WHERE id = ?`)
        .run(otherId, userId);
      return otherId;
    },
    mcp(
      token: string | undefined,
      message: unknown,
      headers: Record<string, string> = {},
    ) {
      return app.request(
        "/mcp",
        {
          body: JSON.stringify(message),
          headers: {
            ...mcpHeaders(),
            ...(isModern(message)
              ? { "MCP-Protocol-Version": modernVersion }
              : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...headers,
          },
          method: "POST",
        },
        bindings,
        executionContext,
      );
    },
    async modernTools(token: string) {
      return rpcResult<ToolListing>(
        await fixture.mcp(token, modernRequest("tools/list", {}), {
          "Mcp-Method": "tools/list",
        }),
      );
    },
    session<T = unknown>(method: string, path: string, body?: unknown) {
      return send<T>(path, method, { cookie }, body);
    },
    setRole(role: string) {
      database
        .query("UPDATE member SET role = ? WHERE organizationId = ?")
        .run(role, organizationId);
    },
    withKey<T = unknown>(
      token: string,
      method: string,
      path: string,
      body?: unknown,
    ) {
      return send<T>(path, method, { Authorization: `Bearer ${token}` }, body);
    },
  };
  return fixture;
}

function legacyInitialize() {
  return {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
      protocolVersion: "2025-06-18",
    },
  };
}

function modernRequest(method: string, params: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    jsonrpc: "2.0",
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {
          name: "test-client",
          version: "1.0.0",
        },
        "io.modelcontextprotocol/protocolVersion": modernVersion,
      },
    },
  };
}

function mcpHeaders(): Record<string, string> {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
}

function isModern(message: unknown) {
  const params = (message as { params?: { _meta?: unknown } }).params;
  return params?._meta !== undefined;
}

/** Reads a JSON-RPC result from a JSON or single-event SSE response. */
async function rpcResult<T>(response: Response): Promise<T> {
  const message = await rpcMessage<T>(response);
  expect(message.error).toBeUndefined();
  return message.result as T;
}

async function rpcMessage<T = unknown>(response: Response) {
  const text = await response.text();
  expect({ status: response.status, text }).toMatchObject({ status: 200 });
  const payload = response.headers
    .get("content-type")
    ?.startsWith("text/event-stream")
    ? (text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .at(-1) ?? "")
    : text;
  return JSON.parse(payload) as { error?: unknown; result?: T };
}

function now() {
  return new Date().toISOString();
}

function testBindings(database: Database): Bindings {
  return {
    AUTH_EMAIL_FROM: "security@auth.balebase.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.test",
    CORS_ORIGIN: "https://app.test",
    DB: toD1(database),
    EMAIL: {
      send: async () => ({ messageId: "test-message" }),
    } as unknown as SendEmail,
    IMAGES: {} as ImagesBinding,
    INBOUND_EMAIL_DOMAIN: "inbox.balebase.com",
    STORAGE: {} as R2Bucket,
  };
}

interface TestStatement {
  execute: () => unknown;
}

function toD1(database: Database) {
  return {
    batch: async (statements: TestStatement[]) =>
      statements.map((statement) => statement.execute()),
    exec: async (query: string) => database.exec(query),
    prepare: (query: string) => {
      let values: SQLQueryBindings[] = [];
      const run = () => {
        const result = database.query(query).run(...values);
        return {
          meta: { changes: result.changes },
          results: [],
          success: true,
        };
      };
      const statement = {
        all: async () => {
          const results = database.query(query).all(...values);
          const meta = database
            .query(
              `SELECT changes() AS changes,
                      last_insert_rowid() AS last_row_id`,
            )
            .get() as { changes: number; last_row_id: number };
          return { meta, results, success: true };
        },
        bind: (...nextValues: SQLQueryBindings[]) => {
          values = nextValues;
          return statement;
        },
        execute: () => run(),
        first: async () => database.query(query).get(...values),
        raw: async () => database.query(query).values(...values),
        run: async () => run(),
      };
      return statement;
    },
  } as unknown as D1Database;
}
