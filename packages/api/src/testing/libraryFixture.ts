import type { Database, SQLQueryBindings } from "bun:sqlite";
import { activity } from "../activity/activity";
import type { ApiKeyPrincipal } from "../auth/apiEnv";
import { businesses } from "../businesses/businesses";
import { inbox } from "../inbox/inbox";
import { libraryFolders } from "../library/libraryFolders";
import { objects } from "../library/objects";
import { memoryStorage, testBindings } from "./bindings";
import { queryHooks, toD1 } from "./d1";
import { createTestDatabase } from "./database";
import { requester } from "./http";
import { seedGroup, seedMember, seedOrganization, seedUser } from "./seed";
import { testApp } from "./session";

const timestamp = "2026-10-01T12:00:00.000Z";

export interface StoredEvent {
  action: string;
  actor_api_key_channel: string | null;
  actor_api_key_name: string | null;
  actor_user_id: string;
  details: Record<string, unknown>;
  root_id: string;
  root_label: string;
  root_type: string;
  subject_id: string;
  subject_type: string;
}

/**
 * Library, inbox, business, and activity routes over one database, for
 * organization `org-1`: `owner-user` (owner), `member-user`, and
 * `finance-user` (a member with Finance), plus `other-user`, who owns
 * `org-2`. Seeds the emails `email-1` and `email-2`, equipment `equipment-1`,
 * transaction `txn-1`, and the owner's API key `key`; set `apiKey` to make
 * requests through it.
 */
export function libraryFixture() {
  const database = createTestDatabase();
  seed(database);
  const hooks = queryHooks();
  const { bucket, stored } = memoryStorage();
  const bindings = testBindings({
    DB: toD1(database, hooks),
    STORAGE: bucket,
  });
  const state: { apiKey: ApiKeyPrincipal | undefined } = { apiKey: undefined };
  const roles: Record<string, [string, string]> = {
    "finance-user": ["org-1", "member"],
    "member-user": ["org-1", "member"],
    "other-user": ["org-2", "owner"],
    "owner-user": ["org-1", "owner"],
  };
  const as = (userId: string) => {
    const [organizationId, organizationRole] = roles[userId] ?? ["org-1", ""];
    const app = testApp({}, { organizationId, organizationRole, userId });
    // A failed write answers 500, as the API's error handler does.
    app.onError((_error, context) => context.json({ error: "Failed." }, 500));
    app.use("*", async (context, next) => {
      if (state.apiKey) context.set("apiKey", state.apiKey);
      await next();
    });
    app.route("/api/objects", objects);
    app.route("/api/library/folders", libraryFolders);
    app.route("/api/inbox", inbox);
    app.route("/api/businesses", businesses);
    app.route("/api/activity", activity);
    return requester(app, bindings);
  };
  return {
    as,
    database,
    /** Organization `org-1`'s events, oldest first, but for its API key's. */
    events: (where = "1", ...values: SQLQueryBindings[]) =>
      (
        database
          .query(
            `SELECT action, root_type, root_id, root_label, subject_type,
                    subject_id, actor_user_id, actor_api_key_name,
                    actor_api_key_channel, details
             FROM activity_events
             WHERE organization_id = 'org-1' AND root_type <> 'api_key'
               AND (${where})
             ORDER BY id`,
          )
          .all(...values) as Array<StoredEvent & { details: string }>
      ).map((row) => ({
        ...row,
        details: JSON.parse(row.details) as Record<string, unknown>,
      })),
    /** Makes every event insert, and so every audited write, fail. */
    failActivity: () =>
      database
        .query(
          `CREATE TRIGGER fail_activity BEFORE INSERT ON activity_events
           BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`,
        )
        .run(),
    hooks,
    state,
    stored,
    /** Makes requests through the owner's API key over `channel`. */
    useApiKey: (channel: "mcp" | "rest") => {
      state.apiKey = {
        access: "write",
        channel,
        id: "key",
        organizationId: "org-1",
      } as ApiKeyPrincipal;
    },
  };
}

function seed(database: Database) {
  const run = (query: string, ...values: SQLQueryBindings[]) =>
    database.query(query).run(...values);
  for (const id of ["owner-user", "member-user", "finance-user", "other-user"])
    seedUser(database, { createdAt: timestamp, id });
  for (const id of ["org-1", "org-2"])
    seedOrganization(database, { createdAt: timestamp, id });
  seedMember(database, {
    organizationId: "org-1",
    role: "owner",
    userId: "owner-user",
  });
  seedMember(database, { organizationId: "org-1", userId: "member-user" });
  seedMember(database, { organizationId: "org-1", userId: "finance-user" });
  seedMember(database, {
    organizationId: "org-2",
    role: "owner",
    userId: "other-user",
  });
  seedGroup(database, { organizationId: "org-1", userIds: ["finance-user"] });
  run(
    `INSERT INTO organization_api_keys
     (id, organization_id, name, access, token_prefix, token_hash, created_by,
      created_at)
     VALUES ('key', 'org-1', 'Automation', 'write', 'test', 'hash',
             'owner-user', ?)`,
    timestamp,
  );
  for (const [id, subject] of [
    ["email-1", "Lease renewal"],
    ["email-2", null],
  ] as const)
    run(
      `INSERT INTO inbound_emails
       (id, organization_id, envelope_from, envelope_to, subject,
        raw_object_key, raw_size, received_at)
       VALUES (?, 'org-1', 'sender@example.com', 'upload@inbox.example.com',
               ?, ?, 1, ?)`,
      id,
      subject,
      `raw/${id}`,
      timestamp,
    );
  run(
    `INSERT INTO equipment
     (id, organization_id, type, make, model, created_at, updated_at)
     VALUES ('equipment-1', 'org-1', 'laptop', 'Dell', 'XPS 13', ?, ?)`,
    timestamp,
    timestamp,
  );
  run(
    `INSERT INTO plaid_items
     (id, organization_id, plaid_item_id, access_token_ciphertext,
      access_token_iv, created_by, created_at, updated_at)
     VALUES ('item-1', 'org-1', 'plaid-item-1', '', '', 'finance-user', ?, ?)`,
    timestamp,
    timestamp,
  );
  run(
    `INSERT INTO plaid_accounts
     (id, plaid_account_id, organization_id, plaid_item_record_id, name, type,
      updated_at)
     VALUES ('account-1', 'plaid-account-1', 'org-1', 'item-1', 'Checking',
             'depository', ?)`,
    timestamp,
  );
  run(
    `INSERT INTO plaid_transactions
     (id, plaid_transaction_id, organization_id, plaid_item_record_id,
      account_record_id, name, merchant_name, amount, currency_code,
      transaction_date, pending, source_status, updated_at)
     VALUES ('txn-1', 'plaid-txn-1', 'org-1', 'item-1', 'account-1',
             'Test Cafe Purchase', 'Test Cafe', 42.75, 'USD', '2026-09-18', 0,
             'active', ?)`,
    timestamp,
  );
}
