import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { findActivity } from "../shared/activity";
import {
  createCategory,
  createFixture,
  jsonRequest,
  mockPlaid,
  seedTransactions,
  testApp,
} from "../testing/financeFixture";
import { type ApiTestEnv, withTestSession } from "../testing/session";
import { createFinanceRouter } from "./finance";
import type { PlaidRequest } from "./plaid";

type Fixture = Awaited<ReturnType<typeof createFixture>>;

interface EventRow {
  action: string;
  actor_api_key_channel: string | null;
  actor_api_key_id: string | null;
  actor_user_id: string;
  details: string;
  root_id: string;
  root_label: string;
  root_type: string;
}

function events(fixture: Fixture, action: string) {
  return fixture.database
    .query<EventRow, [string]>(
      `SELECT action, actor_api_key_channel, actor_api_key_id, actor_user_id,
              details, root_id, root_label, root_type
       FROM activity_events WHERE action = ? ORDER BY id`,
    )
    .all(action)
    .map((row) => ({
      ...row,
      details: JSON.parse(row.details) as Record<string, unknown>,
    }));
}

/** Fails every insert of `action`, so its batch must roll back. */
function failActivity(fixture: Fixture, action: string) {
  fixture.database.exec(`CREATE TRIGGER fail_activity
    BEFORE INSERT ON activity_events WHEN NEW.action = '${action}'
    BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
}

/** The finance routes called through user-1's write key over MCP. */
function apiKeyApp(fixture: Fixture, requestPlaid: PlaidRequest) {
  fixture.database.run(`INSERT INTO organization_api_keys
    (id, organization_id, name, access, token_prefix, token_hash, created_by,
     created_at)
    VALUES ('key-1', 'org_user-1', 'Bookkeeper', 'write', 'bb_test', 'hash-1',
            'user-1', '2026-08-19T12:00:00.000Z')`);
  const app = new Hono<ApiTestEnv>();
  app.use(
    "*",
    withTestSession({
      email: "person@example.com",
      name: "Example Person",
      organizationId: "org_user-1",
      userId: "user-1",
    }),
  );
  app.use("*", async (context, next) => {
    context.set("apiKey", {
      access: "write",
      channel: "mcp",
      id: "key-1",
      organizationId: "org_user-1",
    });
    await next();
  });
  app.route("/api/finance", createFinanceRouter(requestPlaid));
  return app;
}

/** Plaid answers every exchange with the same Item. */
function sameItemPlaid(): PlaidRequest {
  const plaid = mockPlaid();
  return async <T>(
    env: Parameters<PlaidRequest>[0],
    path: string,
    body: Parameters<PlaidRequest>[2],
  ) => {
    if (path === "/item/public_token/exchange")
      return {
        access_token: "access-sandbox-test-1",
        item_id: "item-shared",
      } as T;
    return plaid<T>(env, path, body);
  };
}

function exchange(
  fixture: Fixture,
  app = fixture.app,
  institution = { institutionId: "ins_1", institutionName: "First Bank" },
) {
  return jsonRequest<{ connectionId: string }>(
    app,
    fixture.bindings,
    "/exchange",
    "POST",
    { publicToken: "public-sandbox-test", ...institution },
  );
}

describe("bank connection activity", () => {
  it("records who connected a bank once, without Plaid identifiers", async () => {
    const fixture = await createFixture();
    const plaid = sameItemPlaid();
    const app = testApp("org_user-1", plaid);
    const created = await exchange(fixture, app);
    expect(created.status).toBe(201);
    const recorded = events(fixture, "finance.connection_created");
    expect(recorded).toEqual([
      {
        action: "finance.connection_created",
        actor_api_key_channel: null,
        actor_api_key_id: null,
        actor_user_id: "user-1",
        details: { institutionId: "ins_1", institutionName: "First Bank" },
        root_id: created.body.connectionId,
        root_label: "First Bank",
        root_type: "finance_connection",
      },
    ]);
    expect(JSON.stringify(recorded)).not.toContain("item-shared");
    expect(JSON.stringify(recorded)).not.toContain("access-sandbox");
    // Exchanging an Item the organization already has adds nothing.
    const again = await exchange(fixture, app);
    expect(again.body.connectionId).toBe(created.body.connectionId);
    // Another organization cannot take over the Item, and records nothing.
    const foreign = await exchange(fixture, testApp("organization-2", plaid));
    expect(foreign.status).toBe(409);
    expect(events(fixture, "finance.connection_created")).toHaveLength(1);
  });

  it("attributes a key-made connection to the key and channel", async () => {
    const fixture = await createFixture();
    const created = await exchange(
      fixture,
      apiKeyApp(fixture, fixture.requestPlaid),
    );
    expect(created.status).toBe(201);
    expect(events(fixture, "finance.connection_created")).toMatchObject([
      {
        actor_api_key_channel: "mcp",
        actor_api_key_id: "key-1",
        actor_user_id: "user-1",
      },
    ]);
  });

  it("stores no connection when its event cannot be recorded", async () => {
    const fixture = await createFixture();
    failActivity(fixture, "finance.connection_created");
    expect((await exchange(fixture)).status).toBe(500);
    expect(fixture.database.query("SELECT id FROM plaid_items").all()).toEqual(
      [],
    );
  });
});

describe("login repair activity", () => {
  /** The finance routes as another member, user-2. */
  function otherMemberApp(fixture: Fixture) {
    const app = new Hono<ApiTestEnv>();
    app.use(
      "*",
      withTestSession({
        email: "other@example.com",
        name: "Other Person",
        organizationId: "org_user-1",
        userId: "user-2",
      }),
    );
    app.route("/api/finance", createFinanceRouter(fixture.requestPlaid));
    return app;
  }

  async function brokenConnection(fixture: Fixture, app = fixture.app) {
    const { body } = await exchange(fixture, app);
    fixture.database
      .query(
        `UPDATE plaid_items SET status = 'error',
           error_code = 'ITEM_LOGIN_REQUIRED', error_message = 'Log in again'
         WHERE id = ?`,
      )
      .run(body.connectionId);
    const id = body.connectionId;
    const openLink = async (linkApp = app) =>
      (
        await jsonRequest<{ linkToken: string }>(
          linkApp,
          fixture.bindings,
          `/connections/${id}/link-token`,
          "POST",
        )
      ).body.linkToken;
    const repair = (linkToken: string, repairApp = app, connectionId = id) =>
      jsonRequest(
        repairApp,
        fixture.bindings,
        `/connections/${connectionId}/login-repairs`,
        "POST",
        { linkToken },
      );
    return { id, openLink, repair };
  }

  it("records who repaired a login and what was wrong, once per Link session", async () => {
    const fixture = await createFixture();
    const { id, openLink, repair } = await brokenConnection(fixture);
    const linkToken = await openLink();
    expect((await repair(linkToken)).status).toBe(204);
    const recorded = events(fixture, "finance.connection_repaired");
    expect(recorded).toEqual([
      {
        action: "finance.connection_repaired",
        actor_api_key_channel: null,
        actor_api_key_id: null,
        actor_user_id: "user-1",
        details: {
          errorCodeBefore: "ITEM_LOGIN_REQUIRED",
          institutionName: "First Bank",
          statusBefore: "error",
        },
        root_id: id,
        root_label: "First Bank",
        root_type: "finance_connection",
      },
    ]);
    for (const secret of ["item-sandbox", "access-sandbox", linkToken])
      expect(JSON.stringify(recorded)).not.toContain(secret);
    // The session is used up: replaying the report records nothing.
    expect((await repair(linkToken)).status).toBe(404);
    expect(events(fixture, "finance.connection_repaired")).toHaveLength(1);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM finance_login_repair_sessions")
        .get(),
    ).toEqual({ count: 0 });
    // Finance history only.
    const visible = (includeFinance: boolean) =>
      findActivity(
        fixture.bindings.DB,
        "org_user-1",
        undefined,
        undefined,
        includeFinance,
        "finance_connection",
      );
    expect((await visible(false))?.events).toEqual([]);
    expect((await visible(true))?.events).toMatchObject([
      { action: "finance.connection_repaired" },
      { action: "finance.connection_created" },
    ]);
  });

  it("records the state from when Link opened, even after the sync cleared it", async () => {
    const fixture = await createFixture();
    const { id, openLink, repair } = await brokenConnection(fixture);
    const linkToken = await openLink();
    // The sync that follows the repair succeeds before the report arrives.
    fixture.database
      .query(
        "UPDATE plaid_items SET status = 'active', error_code = NULL, error_message = NULL WHERE id = ?",
      )
      .run(id);
    expect((await repair(linkToken)).status).toBe(204);
    expect(events(fixture, "finance.connection_repaired")).toMatchObject([
      {
        details: {
          errorCodeBefore: "ITEM_LOGIN_REQUIRED",
          statusBefore: "error",
        },
      },
    ]);
  });

  it("attributes a key-made repair to the key", async () => {
    const fixture = await createFixture();
    const app = apiKeyApp(fixture, fixture.requestPlaid);
    const { openLink, repair } = await brokenConnection(fixture, app);
    expect((await repair(await openLink())).status).toBe(204);
    expect(events(fixture, "finance.connection_repaired")).toMatchObject([
      { actor_api_key_channel: "mcp", actor_api_key_id: "key-1" },
    ]);
  });

  it("refuses reports without the reporter's own open Link session for that bank", async () => {
    const fixture = await createFixture();
    const { openLink, repair } = await brokenConnection(fixture);
    const other = await exchange(fixture, fixture.app, {
      institutionId: "ins_2",
      institutionName: "Second Bank",
    });
    // No session opened yet, or a made-up token.
    expect((await repair("link-sandbox-test")).status).toBe(404);
    const linkToken = await openLink();
    expect((await repair("link-made-up")).status).toBe(404);
    // Another member, another organization, or another bank.
    expect((await repair(linkToken, otherMemberApp(fixture))).status).toBe(404);
    expect(
      (await repair(linkToken, testApp("organization-2", fixture.requestPlaid)))
        .status,
    ).toBe(404);
    expect(
      (await repair(linkToken, fixture.app, other.body.connectionId)).status,
    ).toBe(404);
    // An expired session.
    fixture.database.run(
      "UPDATE finance_login_repair_sessions SET expires_at = '2000-01-01T00:00:00.000Z'",
    );
    expect((await repair(linkToken)).status).toBe(404);
    expect((await repair("")).status).toBe(400);
    expect(events(fixture, "finance.connection_repaired")).toEqual([]);
  });

  it("keeps the session when recording fails, and records nothing once disconnected", async () => {
    const fixture = await createFixture();
    const { id, openLink, repair } = await brokenConnection(fixture);
    const linkToken = await openLink();
    failActivity(fixture, "finance.connection_repaired");
    expect((await repair(linkToken)).status).toBe(500);
    expect(events(fixture, "finance.connection_repaired")).toEqual([]);
    fixture.database.run("DROP TRIGGER fail_activity");
    // The failed report left its session, so the app's retry records it.
    expect((await repair(linkToken)).status).toBe(204);
    const next = await openLink();
    await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/connections/${id}`,
      "DELETE",
    );
    expect((await repair(next)).status).toBe(404);
    expect(events(fixture, "finance.connection_repaired")).toHaveLength(1);
  });
});

describe("connection data deletion activity", () => {
  async function disconnectedConnection(fixture: Fixture, app = fixture.app) {
    const { body } = await exchange(fixture, app);
    const id = body.connectionId;
    await jsonRequest(app, fixture.bindings, `/connections/${id}/sync`, "POST");
    const [transaction] = fixture.database
      .query<{ id: string }, [string]>(
        "SELECT id FROM plaid_transactions WHERE plaid_item_record_id = ?",
      )
      .all(id);
    await jsonRequest(
      app,
      fixture.bindings,
      `/transactions/${transaction?.id}/annotation`,
      "PATCH",
      { labels: ["tax"], note: "Receipt filed", reviewed: true },
    );
    const disconnected = await jsonRequest(
      app,
      fixture.bindings,
      `/connections/${id}`,
      "DELETE",
    );
    expect(disconnected.status).toBe(204);
    const remove = () =>
      jsonRequest(app, fixture.bindings, `/connections/${id}/data`, "DELETE");
    return { id, remove };
  }

  it("records the deletion, its counts, and keeps the record after the purge", async () => {
    const fixture = await createFixture();
    const { id, remove } = await disconnectedConnection(fixture);
    expect((await remove()).status).toBe(204);
    expect(fixture.database.query("SELECT id FROM plaid_items").all()).toEqual(
      [],
    );
    expect(events(fixture, "finance.connection_data_deleted")).toEqual([
      {
        action: "finance.connection_data_deleted",
        actor_api_key_channel: null,
        actor_api_key_id: null,
        actor_user_id: "user-1",
        details: {
          accountCount: 1,
          annotationCount: 1,
          emailLinkCount: 0,
          institutionName: "First Bank",
          issueCount: 0,
          openIssueCount: 0,
          transactionCount: 1,
        },
        root_id: id,
        root_label: "First Bank",
        root_type: "finance_connection",
      },
    ]);
    // The purge still removes the rest of the connection's history.
    expect(
      fixture.database
        .query(
          "SELECT action FROM activity_events WHERE root_type IN ('finance_connection', 'finance_transaction')",
        )
        .all(),
    ).toEqual([{ action: "finance.connection_data_deleted" }]);
    // A second delete finds nothing and records nothing.
    expect((await remove()).status).toBe(404);
    expect(events(fixture, "finance.connection_data_deleted")).toHaveLength(1);
    const visible = (includeFinance: boolean) =>
      findActivity(
        fixture.bindings.DB,
        "org_user-1",
        undefined,
        undefined,
        includeFinance,
      );
    expect((await visible(false))?.events).toEqual([]);
    expect((await visible(true))?.events).toMatchObject([
      { action: "finance.connection_data_deleted", root: { id } },
    ]);
    // Purging the organization removes the record with the rest.
    fixture.database.run("DELETE FROM organization WHERE id = 'org_user-1'");
    expect(events(fixture, "finance.connection_data_deleted")).toEqual([]);
  });

  it("counts the issues and email links the deletion removes", async () => {
    const fixture = await createFixture();
    const { id, remove } = await disconnectedConnection(fixture);
    const other = await exchange(fixture, fixture.app, {
      institutionId: "ins_2",
      institutionName: "Second Bank",
    });
    await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/connections/${other.body.connectionId}/sync`,
      "POST",
    );
    const transactionOf = (connectionId: string) =>
      fixture.database
        .query<{ id: string }, [string]>(
          "SELECT id FROM plaid_transactions WHERE plaid_item_record_id = ? LIMIT 1",
        )
        .get(connectionId)?.id ?? "";
    const deleted = transactionOf(id);
    const kept = transactionOf(other.body.connectionId);
    const now = "2026-08-19T12:00:00.000Z";
    for (const [issueId, target, status] of [
      ["issue-open", deleted, "open"],
      ["issue-resolved", deleted, "resolved"],
      ["issue-kept", kept, "open"],
    ] as [string, string, string][])
      fixture.database
        .query(
          `INSERT INTO issues (id, organization_id, target_type, target_id,
             title, status, created_by, created_at, updated_at)
           VALUES (?, 'org_user-1', 'finance_transaction', ?, 'Receipt', ?,
                   'user-1', ?, ?)`,
        )
        .run(issueId, target, status, now, now);
    fixture.database.run(`INSERT INTO inbound_emails
      (id, organization_id, envelope_from, envelope_to, raw_object_key,
       raw_size, received_at)
      VALUES ('email-1', 'org_user-1', 'a@example.com', 'b@example.com',
              'raw/email-1', 1, '${now}')`);
    for (const [linkId, target] of [
      ["link-deleted", deleted],
      ["link-kept", kept],
    ] as [string, string][])
      fixture.database
        .query(
          `INSERT INTO inbound_email_links
             (id, organization_id, email_id, target_type, target_id,
              created_at)
           VALUES (?, 'org_user-1', 'email-1', 'finance_transaction', ?, ?)`,
        )
        .run(linkId, target, now);
    expect((await remove()).status).toBe(204);
    expect(
      events(fixture, "finance.connection_data_deleted")[0]?.details,
    ).toMatchObject({ emailLinkCount: 1, issueCount: 2, openIssueCount: 1 });
    // The triggers removed exactly what the event counts.
    expect(
      fixture.database
        .query(
          "SELECT (SELECT group_concat(id) FROM issues) AS issues, (SELECT group_concat(id) FROM inbound_email_links) AS links",
        )
        .get(),
    ).toEqual({ issues: "issue-kept", links: "link-kept" });
  });

  it("attributes a key-made deletion to the key", async () => {
    const fixture = await createFixture();
    const app = apiKeyApp(fixture, fixture.requestPlaid);
    const { remove } = await disconnectedConnection(fixture, app);
    expect((await remove()).status).toBe(204);
    expect(events(fixture, "finance.connection_data_deleted")).toMatchObject([
      { actor_api_key_channel: "mcp", actor_api_key_id: "key-1" },
    ]);
  });

  it("refuses connected banks and keeps everything when recording fails", async () => {
    const fixture = await createFixture();
    const { body } = await exchange(fixture);
    const active = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/connections/${body.connectionId}/data`,
      "DELETE",
    );
    expect(active.status).toBe(409);
    const { remove } = await disconnectedConnection(fixture);
    failActivity(fixture, "finance.connection_data_deleted");
    expect((await remove()).status).toBe(500);
    expect(
      fixture.database
        .query(
          "SELECT (SELECT COUNT(*) FROM plaid_items) AS items, (SELECT COUNT(*) FROM plaid_transactions) AS transactions, (SELECT COUNT(*) FROM finance_transaction_annotations) AS annotations",
        )
        .get(),
    ).toEqual({ annotations: 1, items: 2, transactions: 1 });
    expect(events(fixture, "finance.connection_data_deleted")).toEqual([]);
  });

  it("deletes and records nothing when the connection changes mid-request", async () => {
    const fixture = await createFixture();
    const { id, remove } = await disconnectedConnection(fixture);
    fixture.hooks.before("finance.connection_data_deleted", () => {
      fixture.database
        .query("UPDATE plaid_items SET status = 'active' WHERE id = ?")
        .run(id);
    });
    expect((await remove()).status).toBe(409);
    expect(
      fixture.database
        .query(
          "SELECT (SELECT COUNT(*) FROM plaid_transactions) AS transactions, (SELECT COUNT(*) FROM finance_transaction_annotations) AS annotations",
        )
        .get(),
    ).toEqual({ annotations: 1, transactions: 1 });
    expect(events(fixture, "finance.connection_data_deleted")).toEqual([]);
  });
});

describe("connection history", () => {
  it("pages a connection's own history, including after it disconnects", async () => {
    const fixture = await createFixture();
    const { body } = await exchange(fixture);
    const id = body.connectionId;
    const other = await exchange(fixture, fixture.app, {
      institutionId: "ins_2",
      institutionName: "Second Bank",
    });
    await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/connections/${id}`,
      "DELETE",
    );
    const history = await jsonRequest<{
      events: { action: string; root: { id: string } }[];
      nextCursor: string | null;
    }>(fixture.app, fixture.bindings, `/connections/${id}/activity`, "GET");
    expect(history.status).toBe(200);
    expect(history.body.events.map(({ action }) => action)).toEqual([
      "finance.connection_disconnected",
      "finance.connection_created",
    ]);
    expect(history.body.events.every(({ root }) => root.id === id)).toBeTrue();
    expect(other.body.connectionId).not.toBe(id);
    expect(history.body.nextCursor).toBeNull();
    const foreign = await jsonRequest(
      testApp("organization-2", fixture.requestPlaid),
      fixture.bindings,
      `/connections/${id}/activity`,
      "GET",
    );
    expect(foreign.status).toBe(404);
    const invalid = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/connections/${id}/activity?cursor=nope`,
      "GET",
    );
    expect(invalid.status).toBe(400);
  });

  it("pages past fifty events with the cursor", async () => {
    const fixture = await createFixture();
    const { body } = await exchange(fixture);
    const id = body.connectionId;
    for (let index = 0; index < 55; index++) {
      await jsonRequest(
        fixture.app,
        fixture.bindings,
        `/connections/${id}/sync-settings`,
        "PATCH",
        { dailySync: index % 2 === 0 },
      );
    }
    const read = (cursor = "") =>
      jsonRequest<{ events: unknown[]; nextCursor: string | null }>(
        fixture.app,
        fixture.bindings,
        `/connections/${id}/activity${cursor && `?cursor=${cursor}`}`,
        "GET",
      );
    const first = await read();
    expect(first.body.events).toHaveLength(50);
    const second = await read(first.body.nextCursor ?? "");
    expect(second.body.events).toHaveLength(6);
    expect(second.body.nextCursor).toBeNull();
  });
});

describe("expense category activity", () => {
  it("records creation, renames, and deletion with their details", async () => {
    const fixture = await createFixture();
    seedTransactions(fixture.database);
    const id = await createCategory(fixture, "Meals");
    expect(events(fixture, "finance.category_created")).toEqual([
      expect.objectContaining({
        actor_user_id: "user-1",
        details: { name: "Meals", slug: "meals" },
        root_id: id,
        root_label: "Meals",
        root_type: "finance_category",
      }),
    ]);
    const duplicate = await jsonRequest(
      fixture.app,
      fixture.bindings,
      "/categories",
      "POST",
      { name: "meals" },
    );
    expect(duplicate.status).toBe(409);
    expect(events(fixture, "finance.category_created")).toHaveLength(1);

    const rename = (name: string, categoryId = id) =>
      jsonRequest(
        fixture.app,
        fixture.bindings,
        `/categories/${categoryId}`,
        "PATCH",
        { name },
      );
    expect((await rename("Team meals")).status).toBe(200);
    expect((await rename("Team meals")).status).toBe(200);
    expect((await rename("Team meals", "missing")).status).toBe(404);
    expect(events(fixture, "finance.category_renamed")).toEqual([
      expect.objectContaining({
        details: {
          afterName: "Team meals",
          afterSlug: "team-meals",
          beforeName: "Meals",
          beforeSlug: "meals",
        },
        root_label: "Team meals",
      }),
    ]);

    for (const transactionId of ["report-txn-0", "report-txn-1"]) {
      await jsonRequest(
        fixture.app,
        fixture.bindings,
        `/transactions/${transactionId}/category`,
        "PUT",
        { categoryId: id },
      );
    }
    const remove = () =>
      jsonRequest(fixture.app, fixture.bindings, `/categories/${id}`, "DELETE");
    expect((await remove()).status).toBe(204);
    expect((await remove()).status).toBe(404);
    expect(events(fixture, "finance.category_deleted")).toEqual([
      expect.objectContaining({
        details: {
          name: "Team meals",
          slug: "team-meals",
          transactionCount: 2,
        },
        root_id: id,
        root_label: "Team meals",
      }),
    ]);
  });

  it("records the defaults actually added, and nothing when none are missing", async () => {
    const fixture = await createFixture();
    await createCategory(fixture, "Meals");
    const add = () =>
      jsonRequest(
        fixture.app,
        fixture.bindings,
        "/categories/defaults",
        "POST",
      );
    expect((await add()).status).toBe(200);
    const [added, ...rest] = events(
      fixture,
      "finance.categories_defaults_added",
    );
    expect(rest).toEqual([]);
    expect(added).toMatchObject({
      actor_user_id: "user-1",
      root_id: "org_user-1",
      root_type: "finance_category",
    });
    const { names } = (added?.details ?? {}) as { names?: unknown };
    expect(names).toBeArrayOfSize(15);
    expect(names).not.toContain("Meals");
    expect(names).toContain("Travel");
    expect((await add()).status).toBe(200);
    expect(events(fixture, "finance.categories_defaults_added")).toHaveLength(
      1,
    );
  });

  it("attributes key-made category changes and hides them without Finance access", async () => {
    const fixture = await createFixture();
    const app = apiKeyApp(fixture, fixture.requestPlaid);
    const created = await jsonRequest<{ category: { id: string } }>(
      app,
      fixture.bindings,
      "/categories",
      "POST",
      { name: "Fuel" },
    );
    expect(created.status).toBe(201);
    await jsonRequest(
      app,
      fixture.bindings,
      `/categories/${created.body.category.id}`,
      "PATCH",
      { name: "Vehicle fuel" },
    );
    await jsonRequest(
      app,
      fixture.bindings,
      `/categories/${created.body.category.id}`,
      "DELETE",
    );
    await jsonRequest(app, fixture.bindings, "/categories/defaults", "POST");
    const recorded = fixture.database
      .query(
        "SELECT action, actor_api_key_id FROM activity_events WHERE root_type = 'finance_category' ORDER BY id",
      )
      .all();
    expect(recorded).toEqual([
      { action: "finance.category_created", actor_api_key_id: "key-1" },
      { action: "finance.category_renamed", actor_api_key_id: "key-1" },
      { action: "finance.category_deleted", actor_api_key_id: "key-1" },
      {
        action: "finance.categories_defaults_added",
        actor_api_key_id: "key-1",
      },
    ]);
    const read = (includeFinance: boolean) =>
      findActivity(
        fixture.bindings.DB,
        "org_user-1",
        undefined,
        undefined,
        includeFinance,
        "finance_category",
      );
    expect((await read(false))?.events).toEqual([]);
    expect((await read(true))?.events).toHaveLength(4);
  });

  it("keeps categories unchanged when their events cannot be recorded", async () => {
    const fixture = await createFixture();
    const id = await createCategory(fixture, "Meals");
    fixture.database.exec(`CREATE TRIGGER fail_activity
      BEFORE INSERT ON activity_events WHEN NEW.root_type = 'finance_category'
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    const request = (path: string, method: string, body?: unknown) =>
      jsonRequest(fixture.app, fixture.bindings, path, method, body);
    expect(
      (await request("/categories", "POST", { name: "Fuel" })).status,
    ).toBe(500);
    expect(
      (await request(`/categories/${id}`, "PATCH", { name: "Food" })).status,
    ).toBe(500);
    expect((await request(`/categories/${id}`, "DELETE")).status).toBe(500);
    expect((await request("/categories/defaults", "POST")).status).toBe(500);
    expect(
      fixture.database
        .query("SELECT name FROM finance_expense_categories")
        .all(),
    ).toEqual([{ name: "Meals" }]);
  });
});
