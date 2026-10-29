import { describe, expect, it } from "bun:test";
import type { Route } from "@balebase/validators/route";
import { routes } from "@balebase/validators/routes";
import { z } from "zod";
import { app } from "../app";
import { mcpTools } from "../mcp/mcp";
import { type McpTool, toolAccess } from "../mcp/mcpToolSchema";
import { activityBatch } from "../shared/activity";
import { testBindings } from "../testing/bindings";
import { toD1 } from "../testing/d1";
import { createTestDatabase } from "../testing/database";
import { apiKeyRouteDenial } from "./apiKeys";
import { createAuth } from "./auth";

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
    inputSchema: { properties?: Record<string, unknown>; required?: string[] };
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
    const name = "Name the API key with 1 to 100 characters.";
    const expiration =
      "Expiration must be 30, 90, 365 days, or null for no expiration.";
    for (const [input, error] of [
      [null, "A name, access level, and expiration are required."],
      [{ access: "read", expiresInDays: 90, name: " " }, name],
      [{ access: "read", expiresInDays: 90, name: "x".repeat(101) }, name],
      [
        { access: "admin", expiresInDays: 90, name: "Key" },
        'Access must be "read" or "write".',
      ],
      [{ access: "write", expiresInDays: 7, name: "Key" }, expiration],
      [{ access: "write", name: "Key" }, expiration],
    ] as const) {
      const response = await fixture.session(
        "POST",
        "/api/organization-settings/api-keys",
        input,
      );
      expect(response).toMatchObject({ body: { error }, status: 400 });
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

  it("attributes activity to the key and whether MCP or REST called it", async () => {
    const fixture = await createFixture();
    const { apiKey, token } = await fixture.createKey("write");
    const created = await fixture.withKey<{ equipment: { id: string } }>(
      token,
      "POST",
      "/api/equipment",
      { make: "Apple", model: "iPhone", type: "cell_phone" },
    );
    expect(created.status).toBe(201);
    const { id } = created.body.equipment;
    const renamed = await fixture.callTool<{ isError?: boolean }>(
      token,
      "update_equipment",
      { id, model: "iPhone Pro" },
    );
    expect(renamed.isError).toBeUndefined();
    const edited = await fixture.session("PATCH", `/api/equipment/${id}`, {
      serialNumber: "SN-1",
    });
    expect(edited.status).toBe(200);
    const deleted = await fixture.callTool<{ isError?: boolean }>(
      token,
      "delete_equipment",
      { id },
    );
    expect(deleted.isError).toBeUndefined();

    const activity = await fixture.session<{
      events: Array<{
        action: string;
        actor: { apiKey: unknown; id: string };
        root: { type: string };
      }>;
    }>("GET", "/api/activity");
    const viaKey = (channel: string) => ({
      channel,
      id: apiKey.id,
      name: "write key",
    });
    expect(
      activity.body.events
        .filter(({ root }) => root.type === "equipment")
        .map(({ action, actor }) => [action, actor.id, actor.apiKey]),
    ).toEqual([
      ["equipment.deleted", fixture.userId, viaKey("mcp")],
      ["equipment.updated", fixture.userId, null],
      ["equipment.updated", fixture.userId, viaKey("mcp")],
      ["equipment.created", fixture.userId, viaKey("rest")],
    ]);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM activity_api_key_context")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("attributes trigger-recorded audit activity to the key", async () => {
    const fixture = await createFixture();
    const { apiKey, token } = await fixture.createKey("write");
    const templates = await fixture.withKey<{
      templates: Array<{ id: string }>;
    }>(token, "GET", "/api/audits/templates");
    const templateId = templates.body.templates[0]?.id;
    const created = await fixture.withKey<{ template: { id: string } }>(
      token,
      "POST",
      "/api/audits/templates",
      { name: "Key form" },
    );
    expect(created.status).toBe(201);
    const started = await fixture.withKey<{ auditId: string }>(
      token,
      "POST",
      `/api/audits/templates/${templateId}/runs`,
    );
    expect(started.status).toBe(201);
    const discarded = await fixture.callTool<{ isError?: boolean }>(
      token,
      "discard_audit",
      { id: started.body.auditId },
    );
    expect(discarded.isError).toBeUndefined();

    const activity = await fixture.session<{
      events: Array<{ action: string; actor: { apiKey: unknown } }>;
    }>("GET", "/api/activity");
    const viaKey = (channel: string) => ({
      channel,
      id: apiKey.id,
      name: "write key",
    });
    expect(
      activity.body.events
        .filter(({ action }) => action.startsWith("audit."))
        .map(({ action, actor }) => [action, actor.apiKey]),
    ).toEqual([
      ["audit.discarded", viaKey("mcp")],
      ["audit.started", viaKey("rest")],
      ["audit.template_created", viaKey("rest")],
    ]);
  });

  it("rolls back a failed key-made batch along with its attribution", async () => {
    const fixture = await createFixture();
    const { apiKey } = await fixture.createKey("write");
    fixture.addEquipment("laptop", fixture.organizationId, "MacBook Pro");
    const database = fixture.bindings.DB;
    await expect(
      activityBatch(
        database,
        {
          access: "write",
          channel: "mcp",
          id: apiKey.id,
          organizationId: fixture.organizationId,
        },
        [
          database
            .prepare(
              `UPDATE equipment SET model = 'Renamed', activity_actor_id = ?
               WHERE id = 'laptop'`,
            )
            .bind(fixture.userId),
          database.prepare("INSERT INTO equipment (id) VALUES ('laptop')"),
        ],
      ),
    ).rejects.toThrow();
    expect(
      fixture.database
        .query(
          `SELECT
             (SELECT COUNT(*) FROM activity_api_key_context) AS contexts,
             (SELECT COUNT(*) FROM activity_events
              WHERE root_type = 'equipment') AS events,
             (SELECT model FROM equipment WHERE id = 'laptop') AS model`,
        )
        .get(),
    ).toEqual({ contexts: 0, events: 0, model: "MacBook Pro" });

    const edited = await fixture.session("PATCH", "/api/equipment/laptop", {
      model: "MacBook Air",
    });
    expect(edited.status).toBe(200);
    const activity = await fixture.session<{
      events: Array<{ action: string; actor: { apiKey: unknown } }>;
    }>("GET", "/api/equipment/laptop/activity");
    expect(
      activity.body.events.map(({ action, actor }) => [action, actor.apiKey]),
    ).toEqual([["equipment.updated", null]]);
  });

  it("credits a key only with its creator's activity in its organization", async () => {
    const fixture = await createFixture();
    const { apiKey } = await fixture.createKey("write");
    const record = (actorId: string, organizationId: string | null) => {
      fixture.database
        .query(
          `INSERT INTO activity_events (
             organization_id, root_type, root_id, root_label, subject_type,
             subject_id, action, actor_user_id, actor_name, actor_email,
             occurred_at, details
           )
           SELECT ?, 'equipment', 'item', 'Item', 'equipment', 'item',
                  'equipment.updated', id, name, email, ?, '{}'
           FROM user WHERE id = ?`,
        )
        .run(organizationId, now(), actorId);
      return fixture.database
        .query(
          `SELECT actor_api_key_id, actor_api_key_name, actor_api_key_channel
           FROM activity_events WHERE id = last_insert_rowid()`,
        )
        .get();
    };
    fixture.database
      .query(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES ('someone-else', 'Someone Else', 'else@example.com', 1, ?, ?)`,
      )
      .run(now(), now());
    fixture.database
      .query(
        `INSERT INTO activity_api_key_context (slot, api_key_id, channel)
         VALUES (1, ?, 'mcp')`,
      )
      .run(apiKey.id);

    const unattributed = {
      actor_api_key_channel: null,
      actor_api_key_id: null,
      actor_api_key_name: null,
    };
    expect(record("someone-else", fixture.organizationId)).toEqual(
      unattributed,
    );
    expect(record(fixture.userId, null)).toEqual(unattributed);
    expect(record(fixture.userId, fixture.organizationId)).toEqual({
      actor_api_key_channel: "mcp",
      actor_api_key_id: apiKey.id,
      actor_api_key_name: "write key",
    });
    expect(() =>
      fixture.database
        .query(
          `INSERT INTO activity_api_key_context (api_key_id, channel)
           VALUES (?, 'rest')`,
        )
        .run(apiKey.id),
    ).toThrow();
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

  it("applies read/write and Finance access to issues through real REST and MCP authentication", async () => {
    const f = await createFixture();
    const read = await f.createKey("read");
    const write = await f.createKey("write");
    f.database
      .query(
        `INSERT INTO plaid_items (id, organization_id, plaid_item_id, access_token_ciphertext, access_token_iv, created_by, created_at, updated_at) VALUES ('issue-item', ?, 'issue-plaid-item', '', '', ?, ?, ?)`,
      )
      .run(f.organizationId, f.userId, now(), now());
    f.database
      .query(
        `INSERT INTO plaid_accounts (id, organization_id, plaid_item_record_id, plaid_account_id, name, type, updated_at) VALUES ('issue-account', ?, 'issue-item', 'issue-plaid-account', 'Checking', 'depository', ?)`,
      )
      .run(f.organizationId, now());
    f.database
      .query(
        `INSERT INTO plaid_transactions (id, organization_id, plaid_item_record_id, account_record_id, plaid_transaction_id, name, amount, transaction_date, pending, updated_at) VALUES ('issue-txn', ?, 'issue-item', 'issue-account', 'issue-plaid-txn', 'Coffee', 25, '2026-10-01', 0, ?)`,
      )
      .run(f.organizationId, now());
    const input = {
      title: "Private transaction issue",
      target: { type: "finance_transaction", id: "issue-txn" },
    };
    expect(
      (await f.withKey(read.token, "POST", "/api/issues", input)).status,
    ).toBe(403);
    const created = await f.callTool<{
      content: Array<{ text: string }>;
      isError?: boolean;
    }>(write.token, "create_issue", input);
    expect(created.isError).toBeUndefined();
    const { issueId } = JSON.parse(created.content[0]?.text ?? "");
    expect(
      (await f.withKey(read.token, "GET", `/api/issues/${issueId}`)).status,
    ).toBe(200);
    expect(
      (
        await f.withKey(read.token, "PATCH", `/api/issues/${issueId}`, {
          expectedRevision: 0,
          status: "resolved",
        })
      ).status,
    ).toBe(403);
    const updated = await f.callTool<{
      content: Array<{ text: string }>;
      isError?: boolean;
    }>(write.token, "update_issue", {
      id: issueId,
      expectedRevision: 0,
      status: "resolved",
    });
    expect(updated.isError).toBeUndefined();
    const history = await f.callTool<{ content: Array<{ text: string }> }>(
      read.token,
      "list_issue_activity",
      { id: issueId },
    );
    expect(JSON.parse(history.content[0]?.text ?? "").events[0]).toMatchObject({
      action: "issue.resolved",
      actor: { id: f.userId, apiKey: { channel: "mcp" } },
    });
    await f.withKey(write.token, "POST", "/api/issues", {
      title: "Public workspace issue",
    });
    f.database
      .query('DELETE FROM "teamMember" WHERE "userId" = ?')
      .run(f.userId);
    const listed = await f.withKey<{ issues: Array<{ title: string }> }>(
      read.token,
      "GET",
      "/api/issues?status=all",
    );
    expect(listed.body.issues.map((issue) => issue.title)).toEqual([
      "Public workspace issue",
    ]);
    const mcpListed = await f.callTool<{ content: Array<{ text: string }> }>(
      read.token,
      "list_issues",
      { status: "all" },
    );
    expect(JSON.stringify(mcpListed)).not.toContain(
      "Private transaction issue",
    );
    for (const path of [
      `/api/issues/${issueId}`,
      `/api/issues/${issueId}/activity`,
    ])
      expect((await f.withKey(read.token, "GET", path)).status).toBe(404);
    expect(
      (
        await f.withKey(write.token, "PATCH", `/api/issues/${issueId}`, {
          expectedRevision: 1,
          status: "open",
        })
      ).status,
    ).toBe(404);
    expect(
      (await f.withKey(write.token, "POST", "/api/issues", input)).status,
    ).toBe(404);
    const denied = await f.callTool<{ isError?: boolean }>(
      write.token,
      "create_issue",
      input,
    );
    expect(denied.isError).toBe(true);
    expect(
      JSON.stringify(
        (await f.withKey(read.token, "GET", "/api/activity")).body,
      ),
    ).not.toContain("Private transaction issue");
  });

  it("exposes the same assignee directory as equipment for members and read-only keys", async () => {
    const f = await createFixture();
    const { token } = await f.createKey("read");
    const equipment = await f.withKey<{ members: unknown[] }>(
      token,
      "GET",
      "/api/equipment",
    );
    const directory = await f.withKey<{ members: unknown[] }>(
      token,
      "GET",
      "/api/issues/members",
    );
    expect(directory.status).toBe(200);
    expect(directory.body.members).toEqual(equipment.body.members);
    const mcp = await f.callTool<{ content: Array<{ text: string }> }>(
      token,
      "list_issue_members",
      {},
    );
    expect(JSON.parse(mcp.content[0]?.text ?? "").members).toEqual(
      equipment.body.members,
    );
    f.setRole("member");
    const ordinaryEquipment = await f.session<{ members: unknown[] }>(
      "GET",
      "/api/equipment",
    );
    const ordinaryDirectory = await f.session<{ members: unknown[] }>(
      "GET",
      "/api/issues/members",
    );
    expect(ordinaryEquipment.status).toBe(200);
    expect(ordinaryDirectory.status).toBe(200);
    expect(ordinaryDirectory.body.members).toEqual(
      ordinaryEquipment.body.members,
    );
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

  it("filters shared activity through MCP with the REST resource types", async () => {
    const fixture = await createFixture();
    const read = await fixture.createKey("read");
    const write = await fixture.createKey("write");
    expect(
      (
        await fixture.withKey(write.token, "POST", "/api/equipment", {
          type: "computer",
          make: "Apple",
          model: "Audited laptop",
        })
      ).status,
    ).toBe(201);
    const listed = await fixture.callTool<{
      content: Array<{ text: string }>;
      isError?: boolean;
    }>(read.token, "list_activity", { resourceType: "equipment" });
    expect(listed.isError).toBeUndefined();
    const page = JSON.parse(listed.content[0]?.text ?? "");
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      action: "equipment.created",
      root: { type: "equipment" },
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

  it("repeats a query parameter for each value in a list argument", async () => {
    const fixture = await createFixture();
    const { token } = await fixture.createKey("read");
    const overview = (accountId: string[]) =>
      fixture.callTool<{ content: Array<{ text: string }>; isError?: boolean }>(
        token,
        "get_finance_overview",
        { accountId, year: "2026" },
      );
    const ids = Array.from({ length: 201 }, (_, index) => `account-${index}`);
    const allowed = await overview(ids.slice(0, 200));
    expect(allowed.isError).toBeUndefined();
    expect(JSON.parse(allowed.content[0]?.text ?? "").transactions).toEqual([]);
    // The listing refuses more than 200 accounts, so this only fails if each
    // id arrived as its own accountId parameter.
    const tooMany = await overview(ids);
    expect(tooMany.isError).toBe(true);
    expect(tooMany.content[0]?.text).toContain("status 400");
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
  const contractRoutes = new Set<Route>(
    Object.values(routes).flatMap((area) => Object.values(area)),
  );
  const served = new Set(
    app.routes.map(({ method, path }) => `${method} ${path}`),
  );

  it("names each tool once", () => {
    const names = mcpTools.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z_]{2,63}$/);
  });

  it("calls a contract route the API serves", () => {
    for (const tool of mcpTools) {
      const { method, path } = tool.route;
      expect({
        contract: contractRoutes.has(tool.route),
        served: served.has(`${method} ${path}`),
        tool: tool.name,
      }).toEqual({ contract: true, served: true, tool: tool.name });
    }
  });

  it("advertises each route's own arguments, every one described", async () => {
    const fixture = await createFixture();
    const { token } = await fixture.createKey("write");
    const { tools } = await fixture.modernTools(token);
    expect(tools.map(({ name }) => name).sort()).toEqual(
      mcpTools.map(({ name }) => name).sort(),
    );
    for (const tool of mcpTools) {
      const { inputSchema } =
        tools.find(({ name }) => name === tool.name) ?? {};
      expect({
        schema: withoutDescriptions(inputSchema),
        tool: tool.name,
      }).toEqual({ schema: routeArguments(tool), tool: tool.name });
      const undescribed = Object.entries(inputSchema?.properties ?? {})
        .filter(([, field]) => !(field as { description?: string }).description)
        .map(([name]) => name);
      expect({ tool: tool.name, undescribed }).toEqual({
        tool: tool.name,
        undescribed: [],
      });
    }
  });

  it("leaves out only optional route fields", () => {
    for (const tool of mcpTools) {
      const fields = [tool.route.query, tool.route.body].flatMap((schema) =>
        schema instanceof z.ZodType
          ? [z.toJSONSchema(schema, { io: "input" })]
          : [],
      );
      for (const name of tool.omit ?? []) {
        expect({
          offered: fields.some((field) => name in (field.properties ?? {})),
          required: fields.some((field) => field.required?.includes(name)),
          tool: `${tool.name}.${name}`,
        }).toEqual({
          offered: true,
          required: false,
          tool: `${tool.name}.${name}`,
        });
      }
    }
  });

  it("requires only optional route fields it offers", () => {
    for (const tool of mcpTools) {
      const fields = [tool.route.query, tool.route.body].flatMap((schema) =>
        schema instanceof z.ZodType
          ? [z.toJSONSchema(schema, { io: "input" })]
          : [],
      );
      for (const name of tool.require ?? []) {
        expect({
          offered: fields.some((field) => name in (field.properties ?? {})),
          required: fields.some((field) => field.required?.includes(name)),
          tool: `${tool.name}.${name}`,
        }).toEqual({
          offered: true,
          required: false,
          tool: `${tool.name}.${name}`,
        });
      }
    }
  });

  it("saves an audit form only from the version a model last read", async () => {
    const fixture = await createFixture();
    const { token } = await fixture.createKey("write");
    const created = await fixture.withKey<{
      template: { id: string; version: number };
    }>(token, "POST", "/api/audits/templates", { name: "Key form" });
    const { id, version } = created.body.template;
    const definition = {
      sections: [
        {
          id: "section",
          items: [
            {
              id: "check",
              prompt: "Check",
              required: true,
              responseType: "check",
            },
          ],
          title: "Checks",
        },
      ],
      version: 1,
    };
    const save = (args: Record<string, unknown>) =>
      fixture.callTool<{ content: Array<{ text: string }>; isError?: boolean }>(
        token,
        "save_audit_template",
        { definition, id, name: "Key form", ...args },
      );
    const unversioned = await save({});
    expect(unversioned.isError).toBe(true);
    expect(unversioned.content[0]?.text).toContain("expectedCurrentVersion");

    expect((await save({ expectedCurrentVersion: version })).isError).toBe(
      undefined,
    );
    const stale = await save({ expectedCurrentVersion: version });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]?.text).toContain("newer version");
  });

  it("only offers routes the key's access level can call", () => {
    for (const tool of mcpTools) {
      const path = tool.route.path.replace(/:\w+/g, "id");
      expect({
        denial: apiKeyRouteDenial(path, tool.route.method, toolAccess(tool)),
        tool: tool.name,
      }).toEqual({ denial: undefined, tool: tool.name });
    }
  });
});

/**
 * What a tool should advertise for its route, without descriptions: path
 * parameters, then the query and body fields as zod converts them.
 */
function routeArguments(tool: McpTool) {
  const { body, path, query } = tool.route;
  const params = [...path.matchAll(/:(\w+)/g)].map(([, name]) => name ?? "");
  const omitted = new Set(tool.omit);
  const fields = [query, body].flatMap((schema) =>
    schema instanceof z.ZodType
      ? [z.toJSONSchema(schema, { io: "input" })]
      : [],
  );
  return {
    additionalProperties: false,
    properties: Object.fromEntries([
      ...params.map((name) => [name, { minLength: 1, type: "string" }]),
      ...fields
        .flatMap((field) => Object.entries(field.properties ?? {}))
        .filter(([name]) => !omitted.has(name)),
    ]),
    required: [
      ...params,
      ...fields
        .flatMap((field) => field.required ?? [])
        .filter((name) => !omitted.has(name)),
      ...(tool.require ?? []),
    ],
    type: "object",
  };
}

/** Drops `description` keywords, keeping fields that happen to share the name. */
function withoutDescriptions(value: unknown, fields = false): unknown {
  if (Array.isArray(value))
    return value.map((item) => withoutDescriptions(item));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => fields || key !== "description")
      .map(([key, entry]) => [
        key,
        withoutDescriptions(entry, !fields && key === "properties"),
      ]),
  );
}

async function createFixture() {
  const database = createTestDatabase();
  const bindings = testBindings({ DB: toD1(database) });
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

it("attributes daily-sync settings to API keys and protects bank activity with Finance access", async () => {
  const f = await createFixture();
  const read = await f.createKey("read");
  const write = await f.createKey("write");
  f.database
    .query(`INSERT INTO plaid_items
    (id, organization_id, plaid_item_id, access_token_ciphertext, access_token_iv, institution_name, created_by, created_at, updated_at)
    VALUES ('daily-item', ?, 'daily-plaid', '', '', 'Example bank', ?, ?, ?)`)
    .run(f.organizationId, f.userId, now(), now());
  const path = "/api/finance/connections/daily-item/sync-settings";
  expect(
    (await f.withKey(read.token, "PATCH", path, { dailySync: true })).status,
  ).toBe(403);
  expect(
    (await f.withKey(write.token, "PATCH", path, { dailySync: true })).status,
  ).toBe(200);
  const historyPath = "/api/activity?resourceType=finance_connection";
  const history = await f.withKey<{ events: unknown[] }>(
    read.token,
    "GET",
    historyPath,
  );
  expect(history.body.events).toEqual([
    expect.objectContaining({
      action: "finance.daily_sync_changed",
      details: { before: false, after: true },
      actor: expect.objectContaining({
        id: f.userId,
        apiKey: { id: write.apiKey.id, name: "write key", channel: "rest" },
      }),
    }),
  ]);
  f.database.query('DELETE FROM "teamMember" WHERE "userId" = ?').run(f.userId);
  expect(
    (await f.withKey(write.token, "PATCH", path, { dailySync: false })).status,
  ).toBe(403);
  expect(
    (await f.withKey<{ events: unknown[] }>(read.token, "GET", historyPath))
      .body.events,
  ).toEqual([]);
});

it("attributes group access changes to the API key that made them", async () => {
  const f = await createFixture();
  const write = await f.createKey("write");
  const { id: groupId } = f.database
    .query('SELECT id FROM "team" WHERE "organizationId" = ?')
    .get(f.organizationId) as { id: string };
  const saved = await f.withKey(
    write.token,
    "PATCH",
    `/api/organization-groups/${groupId}`,
    { capabilities: [], name: "Finance", userIds: [f.userId] },
  );
  expect(saved.status).toBe(200);
  const history = await f.withKey<{ events: unknown[] }>(
    write.token,
    "GET",
    "/api/activity?resourceType=organization_group",
  );
  expect(history.body.events[0]).toMatchObject({
    action: "organization.group_updated",
    actor: {
      apiKey: { channel: "rest", id: write.apiKey.id, name: "write key" },
      id: f.userId,
    },
    details: { removedCapabilities: ["finance"] },
  });
  // The sign-up grant came from the person, not the key.
  expect(history.body.events[1]).toMatchObject({
    action: "organization.group_created",
    actor: { apiKey: null, id: f.userId },
  });
});

it("queues MCP finance sync immediately and exposes saved status to readers", async () => {
  const f = await createFixture();
  const read = await f.createKey("read");
  const write = await f.createKey("write");
  f.database
    .query(`INSERT INTO plaid_items
    (id, organization_id, plaid_item_id, access_token_ciphertext, access_token_iv, institution_name, created_by, created_at, updated_at)
    VALUES ('sync-item', ?, 'sync-plaid', '', '', 'Example bank', ?, ?, ?)`)
    .run(f.organizationId, f.userId, now(), now());
  const sent: { jobId: string }[] = [];
  f.bindings.FINANCE_SYNC_QUEUE = {
    send: async (body: { jobId: string }) => {
      sent.push(body);
    },
  } as unknown as Queue<{ jobId: string }>;
  const result = await f.callTool<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>(write.token, "sync_finance_connection", { id: "sync-item" });
  expect(result.content[0]?.text).toContain('"queued"');
  const job = JSON.parse(result.content[0]?.text ?? "");
  expect(job.status).toBe("queued");
  expect(sent).toEqual([{ jobId: job.id }]);
  const status = await f.callTool<{ content: Array<{ text: string }> }>(
    read.token,
    "get_finance_sync_status",
    { id: "sync-item" },
  );
  expect(JSON.parse(status.content[0]?.text ?? "")).toMatchObject({
    connection: { syncJob: { id: job.id, status: "queued" } },
  });
});
