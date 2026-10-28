import {
  type FinanceAccount,
  type FinanceConnection,
  type FinanceTransaction,
  type FinanceTransactionAnnotation,
  type FinanceTransactionSource,
  financeRoutes,
} from "@balebase/validators/finance";
import type { LinkedEmail } from "@balebase/validators/inbox";
import { Hono } from "hono";
import {
  activityBatch,
  activityStatement,
  findActivity,
  requestActor,
} from "./activity";
import type { ApiEnv } from "./authMiddleware";
import { cursorPage, encodeCursor } from "./cursorPagination";
import { accountDetail } from "./financeAccountDetail";
import {
  addDefaultCategories,
  assignTransactionCategory,
  createCategory,
  deleteCategory,
  listCategories,
  listExpenseCategories,
  renameCategory,
} from "./financeCategories";
import { connectionDetail } from "./financeConnectionDetail";
import type { FinanceContext } from "./financeContext";
import { financeListingFilters } from "./financeListingFilters";
import { expenseReport } from "./financeReports";
import type { PlaidItemRow } from "./financeSync";
import {
  connectionSyncStatus,
  legacySyncConnection,
  startConnectionSync,
  updateSyncSettings,
} from "./financeSyncRoutes";
import { searchTransactions } from "./financeTransactionSearch";
import { listLinkedEmails, toLinkedEmail } from "./inboundEmailLinks";
import { PlaidApiError, type PlaidRequest, plaidRequest } from "./plaid";
import { decryptToken, encryptToken } from "./plaidCrypto";
import { respond } from "./respond";
import type { Bindings } from "./types";
import { respondToUnexpectedError } from "./unexpectedError";

const transactionPageSize = 250;

interface ConnectionRow {
  account_count: number;
  daily_sync: number;
  sync_status: FinanceConnection["syncStatus"];
  created_at: string;
  error_code: string | null;
  id: string;
  institution_id: string | null;
  institution_name: string | null;
  last_synced_at: string | null;
  status: string;
}

interface AccountRow {
  available_balance: number | null;
  currency_code: string | null;
  current_balance: number | null;
  id: string;
  institution_name: string | null;
  mask: string | null;
  name: string;
  official_name: string | null;
  subtype: string | null;
  type: string;
}

interface TransactionRow {
  account_id: string;
  account_name: string;
  amount: number;
  annotation_expense_category_id: string | null;
  annotation_labels: string | null;
  annotation_note: string | null;
  annotation_reviewed: number | null;
  authorized_date: string | null;
  category_detailed: string | null;
  category_primary: string | null;
  currency_code: string | null;
  id: string;
  merchant_name: string | null;
  name: string;
  payment_channel: string | null;
  pending: number;
  transaction_date: string;
}

interface ExchangeResponse {
  access_token: string;
  item_id: string;
}

interface LinkTokenResponse {
  expiration: string;
  link_token: string;
}

interface FinanceInput {
  institutionId?: unknown;
  institutionName?: unknown;
  publicToken?: unknown;
  [key: string]: unknown;
}

interface AnnotationInput {
  labels?: unknown;
  note?: unknown;
  reviewed?: unknown;
}

interface LinkTokenRequest extends Record<string, unknown> {
  redirect_uri?: string;
}

export function createFinanceRouter(requestPlaid: PlaidRequest = plaidRequest) {
  const finance = new Hono<ApiEnv>();

  finance.get("/", async (context) => financeListing(context));
  finance.post("/link-token", async (context) =>
    createLinkToken(context, requestPlaid),
  );
  finance.post("/exchange", async (context) =>
    exchangePublicToken(context, requestPlaid),
  );
  finance.post("/connections/:id/sync", legacySyncConnection);
  finance.post("/connections/:id/sync-jobs", startConnectionSync);
  finance.get("/connections/:id/sync-status", connectionSyncStatus);
  finance.patch("/connections/:id/sync-settings", updateSyncSettings);
  finance.get("/connections/:id", connectionDetail);
  finance.delete("/connections/:id", async (context) =>
    disconnectConnection(context, requestPlaid),
  );
  finance.delete("/connections/:id/data", deleteConnectionData);
  finance.get("/accounts/:id", accountDetail);
  finance.get("/transactions", searchTransactions);
  finance.get("/transactions/:id", transactionDetail);
  finance.get("/transactions/:id/activity", transactionActivity);
  finance.patch("/transactions/:id/annotation", updateTransactionAnnotation);
  finance.put("/transactions/:id/category", assignTransactionCategory);
  finance.get("/categories", listCategories);
  finance.post("/categories", createCategory);
  finance.post("/categories/defaults", addDefaultCategories);
  finance.patch("/categories/:id", renameCategory);
  finance.delete("/categories/:id", deleteCategory);
  finance.get("/reports/expenses", expenseReport);
  finance.onError((error, context) => {
    if (error instanceof PlaidApiError) {
      const status = error.status === 503 ? 503 : 502;
      return context.json({ code: error.code, error: error.message }, status);
    }
    return respondToUnexpectedError(error, context);
  });
  return finance;
}

async function financeListing(context: FinanceContext) {
  const filters = financeListingFilters(context);
  if (!filters)
    return context.json({ error: "Invalid transaction filters." }, 400);
  const organizationId = context.get("organizationId");
  const [connections, accounts, transactions, categories, linkedEmails] =
    await Promise.all([
      listConnections(context.env.DB, organizationId),
      listAccounts(context.env.DB, organizationId),
      listTransactions(context.env.DB, filters),
      listExpenseCategories(context.env.DB, organizationId),
      listLinkedEmails(context.env.DB, organizationId, "finance_transaction"),
    ]);
  const emailsByTransaction = Map.groupBy(
    linkedEmails,
    ({ target_id }) => target_id,
  );
  const page = cursorPage(transactions, transactionPageSize, (row) =>
    encodeCursor(row.transaction_date, row.id),
  );
  return respond(context, financeRoutes.listing, {
    accounts: accounts.map(toAccount),
    categories,
    configured: isConfigured(context.env),
    connections: connections.map(toConnection),
    nextCursor: page.nextCursor,
    transactions: page.items.map((row) =>
      toTransaction(
        row,
        (emailsByTransaction.get(row.id) ?? []).map(toLinkedEmail),
      ),
    ),
  });
}

async function transactionDetail(context: FinanceContext) {
  const organizationId = context.get("organizationId");
  const id = context.req.param("id") ?? "";
  const [[row], source] = await Promise.all([
    listTransactions(context.env.DB, {
      where:
        "txn.organization_id = ? AND txn.id = ? AND txn.source_status = 'active'",
      bindings: [organizationId, id],
    }),
    findTransactionSource(context.env.DB, organizationId, id),
  ]);
  if (!row || !source)
    return context.json({ error: "Transaction not found." }, 404);
  const [categories, emails] = await Promise.all([
    listExpenseCategories(context.env.DB, organizationId),
    listLinkedEmails(
      context.env.DB,
      organizationId,
      "finance_transaction",
      row.id,
    ),
  ]);
  return respond(context, financeRoutes.transaction, {
    transaction: toTransaction(row, emails.map(toLinkedEmail)),
    categories,
    source,
  });
}

/** Stored Plaid fields that the listing omits, for the transaction page. */
async function findTransactionSource(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT txn.plaid_transaction_id AS plaidTransactionId,
              txn.pending_transaction_id AS pendingTransactionId,
              txn.updated_at AS updatedAt,
              item.institution_name AS institutionName,
              account.official_name AS accountOfficialName,
              account.mask AS accountMask, account.type AS accountType,
              account.subtype AS accountSubtype
       FROM plaid_transactions AS txn
       JOIN plaid_accounts AS account ON account.id = txn.account_record_id
       JOIN plaid_items AS item ON item.id = txn.plaid_item_record_id
       WHERE txn.organization_id = ? AND txn.id = ?
         AND txn.source_status = 'active'`,
    )
    .bind(organizationId, id)
    .first<FinanceTransactionSource>();
}

async function transactionActivity(context: FinanceContext) {
  const id = context.req.param("id") ?? "";
  const exists = await context.env.DB.prepare(`SELECT id FROM plaid_transactions
    WHERE id = ? AND organization_id = ? AND source_status = 'active'`)
    .bind(id, context.get("organizationId"))
    .first();
  if (!exists) return context.json({ error: "Transaction not found." }, 404);
  const page = await findActivity(
    context.env.DB,
    context.get("organizationId"),
    context.req.query("cursor"),
    { type: "finance_transaction", id },
    true,
  );
  return page
    ? respond(context, financeRoutes.transactionActivity, page)
    : context.json({ error: "Invalid activity cursor." }, 400);
}

async function createLinkToken(
  context: FinanceContext,
  requestPlaid: PlaidRequest,
) {
  requireEncryptionKey(context.env);
  const body: LinkTokenRequest = {
    client_name: "Balebase",
    country_codes: ["US"],
    language: "en",
    products: ["transactions"],
    transactions: { days_requested: 730 },
    user: {
      client_user_id: clientUserId(
        context.get("organizationId"),
        context.get("authSession").user.id,
      ),
    },
  };
  if (context.env.PLAID_REDIRECT_URI) {
    body.redirect_uri = context.env.PLAID_REDIRECT_URI;
  }
  const result = await requestPlaid<LinkTokenResponse>(
    context.env,
    "/link/token/create",
    body,
  );
  return respond(context, financeRoutes.createLinkToken, {
    expiration: result.expiration,
    linkToken: result.link_token,
  });
}

async function exchangePublicToken(
  context: FinanceContext,
  requestPlaid: PlaidRequest,
) {
  const input = await financeInput(context);
  if (!validText(input?.publicToken, 1_000)) {
    return context.json({ error: "A Plaid public token is required." }, 400);
  }
  const secret = requireEncryptionKey(context.env);
  const result = await requestPlaid<ExchangeResponse>(
    context.env,
    "/item/public_token/exchange",
    { public_token: input.publicToken },
  );
  const organizationId = context.get("organizationId");
  const existing = await findItemByPlaidId(context.env.DB, result.item_id);
  if (existing) {
    return existing.organizationId === organizationId
      ? respond(context, financeRoutes.exchangePublicToken, {
          connectionId: existing.id,
        })
      : context.json({ error: "That connection is already in use." }, 409);
  }
  const id = crypto.randomUUID();
  const encrypted = await encryptToken(
    result.access_token,
    secret,
    `${organizationId}:${id}`,
  );
  await insertConnection(context, input, result, encrypted, id);
  return respond(
    context,
    financeRoutes.exchangePublicToken,
    { connectionId: id },
    201,
  );
}

async function disconnectConnection(
  context: FinanceContext,
  requestPlaid: PlaidRequest,
) {
  const connectionId = context.req.param("id");
  if (!connectionId) {
    return context.json({ error: "Connection not found." }, 404);
  }
  const organizationId = context.get("organizationId");
  const item = await findItem(context.env.DB, organizationId, connectionId);
  if (!item) return context.json({ error: "Connection not found." }, 404);
  const accessToken = await decryptToken(
    {
      ciphertext: item.access_token_ciphertext,
      iv: item.access_token_iv,
    },
    requireEncryptionKey(context.env),
    `${organizationId}:${item.id}`,
  );
  if (!(await claimDisconnection(context.env.DB, item.id)))
    return context.json(
      {
        error:
          "A sync or disconnect is in progress. Try again when it finishes.",
      },
      409,
    );
  try {
    await requestPlaid(context.env, "/item/remove", {
      access_token: accessToken,
    });
  } catch (error) {
    // The earlier request may have removed the remote Item before its local
    // commit was interrupted. An expired claim can finish that disconnection.
    const alreadyRemoved =
      error instanceof PlaidApiError &&
      (error.code === "ITEM_NOT_FOUND" ||
        (item.status === "disconnecting" &&
          error.code === "INVALID_ACCESS_TOKEN"));
    if (!alreadyRemoved) {
      await releaseDisconnectionClaim(context.env.DB, item, error);
      throw error;
    }
  }
  if (!(await recordDisconnection(context, item)))
    return context.json(
      { error: "Connection changed. Reload and try again." },
      409,
    );
  return context.body(null, 204);
}

async function releaseDisconnectionClaim(
  database: D1Database,
  item: { id: string; status: string },
  error: unknown,
) {
  await database
    .prepare(
      `UPDATE plaid_items SET status = ?, disconnect_lease_until = NULL,
        error_code = CASE WHEN ? THEN ? ELSE error_code END,
        error_message = CASE WHEN ? THEN ? ELSE error_message END
        WHERE id = ? AND status = 'disconnecting'`,
    )
    .bind(
      item.status === "disconnecting" ? "error" : item.status,
      item.status === "disconnecting" ? 1 : 0,
      error instanceof PlaidApiError ? error.code : "DISCONNECT_FAILED",
      item.status === "disconnecting" ? 1 : 0,
      error instanceof PlaidApiError
        ? error.message
        : "Could not disconnect this bank. Try again.",
      item.id,
    )
    .run();
}

/** Waiting jobs must not prevent revoking bank access during an outage. Only a
 * live consumer blocks the claim; the same transaction cancels all other work. */
async function claimDisconnection(database: D1Database, id: string) {
  const now = new Date().toISOString();
  const [claimed] = await database.batch([
    database
      .prepare(`UPDATE plaid_items SET status = 'disconnecting', disconnect_lease_until = ?
      WHERE id = ? AND (status IN ('active', 'error') OR
        (status = 'disconnecting' AND disconnect_lease_until <= ?)) AND NOT EXISTS
        (SELECT 1 FROM job_runs WHERE connection_id = ?
          AND status = 'running' AND lease_until > ?)`)
      .bind(new Date(Date.now() + 20 * 60_000).toISOString(), id, now, id, now),
    database
      .prepare(`UPDATE job_runs SET status = 'cancelled', finished_at = ?,
      lease_until = NULL, error_code = 'SYNC_CANCELLED',
      error_message = 'Cancelled by a disconnect request.'
      WHERE connection_id = ? AND status IN ('queued', 'running') AND changes() > 0`)
      .bind(now, id),
  ]);
  return Boolean(claimed?.meta.changes);
}

async function recordDisconnection(
  context: FinanceContext,
  item: NonNullable<Awaited<ReturnType<typeof findItem>>>,
) {
  const now = new Date().toISOString();
  const [result] = await activityBatch(context.env.DB, context.get("apiKey"), [
    context.env.DB.prepare(
      `UPDATE plaid_items SET access_token_ciphertext = '', access_token_iv = '', cursor = NULL,
      status = 'disconnected', daily_sync = 0, disconnect_lease_until = NULL,
      error_code = NULL, error_message = NULL, disconnected_at = ?, updated_at = ?
      WHERE id = ? AND organization_id = ? AND status = 'disconnecting'`,
    ).bind(now, now, item.id, context.get("organizationId")),
    activityStatement(
      context.env.DB,
      {
        action: "finance.connection_disconnected",
        actorId: requestActor(context).userId,
        occurredAt: now,
        organizationId: context.get("organizationId"),
        root: {
          id: item.id,
          label: item.institution_name ?? "Bank connection",
          type: "finance_connection",
        },
        subject: { id: item.id, type: "finance_connection" },
        details: { dailySync: false },
      },
      { sql: "changes() > 0", bindings: [] },
    ),
  ]);
  return Boolean(result?.meta.changes);
}

async function deleteConnectionData(context: FinanceContext) {
  const connectionId = context.req.param("id");
  if (!connectionId) {
    return context.json({ error: "Connection not found." }, 404);
  }
  const organizationId = context.get("organizationId");
  const connection = await context.env.DB.prepare(
    `SELECT status FROM plaid_items WHERE id = ? AND organization_id = ?`,
  )
    .bind(connectionId, organizationId)
    .first<{ status: string }>();
  if (!connection) {
    return context.json({ error: "Connection not found." }, 404);
  }
  if (connection.status !== "disconnected") {
    return context.json(
      { error: "Disconnect the bank before deleting its imported data." },
      409,
    );
  }
  await context.env.DB.batch([
    context.env.DB.prepare(
      `DELETE FROM finance_transaction_annotations
         WHERE organization_id = ? AND transaction_id IN (
           SELECT id FROM plaid_transactions
           WHERE plaid_item_record_id = ? AND organization_id = ?
         )`,
    ).bind(organizationId, connectionId, organizationId),
    context.env.DB.prepare(
      `DELETE FROM plaid_transactions
         WHERE plaid_item_record_id = ? AND organization_id = ?`,
    ).bind(connectionId, organizationId),
    context.env.DB.prepare(
      `DELETE FROM plaid_accounts
         WHERE plaid_item_record_id = ? AND organization_id = ?`,
    ).bind(connectionId, organizationId),
    context.env.DB.prepare(
      "DELETE FROM plaid_items WHERE id = ? AND organization_id = ?",
    ).bind(connectionId, organizationId),
  ]);
  return context.body(null, 204);
}

async function updateTransactionAnnotation(context: FinanceContext) {
  const transactionId = context.req.param("id");
  const input = await annotationInput(context);
  if (!transactionId || !input) {
    return context.json({ error: "A valid annotation is required." }, 400);
  }
  const annotation = normalizeAnnotation(input);
  if (!annotation) {
    return context.json({ error: "A valid annotation is required." }, 400);
  }
  const organizationId = context.get("organizationId");
  const transaction = await context.env.DB.prepare(
    `SELECT id FROM plaid_transactions
       WHERE id = ? AND organization_id = ?`,
  )
    .bind(transactionId, organizationId)
    .first<{ id: string }>();
  if (!transaction) {
    return context.json({ error: "Transaction not found." }, 404);
  }
  const now = new Date().toISOString();
  const userId = context.get("authSession").user.id;
  const statement = context.env.DB.prepare(
    `INSERT INTO finance_transaction_annotations
       (transaction_id, organization_id, note, labels,
        reviewed, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(transaction_id) DO UPDATE SET
         note = excluded.note,
         labels = excluded.labels,
         reviewed = excluded.reviewed,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
  ).bind(
    transactionId,
    organizationId,
    annotation.note,
    JSON.stringify(annotation.labels),
    annotation.reviewed ? 1 : 0,
    userId,
    userId,
    now,
    now,
  );
  await activityBatch(context.env.DB, context.get("apiKey"), [statement]);
  return respond(context, financeRoutes.updateTransactionAnnotation, {
    annotation,
  });
}

async function insertConnection(
  context: FinanceContext,
  input: FinanceInput,
  exchange: ExchangeResponse,
  encrypted: { ciphertext: string; iv: string },
  id: string,
) {
  const now = new Date().toISOString();
  await context.env.DB.prepare(
    `INSERT INTO plaid_items
     (id, organization_id, plaid_item_id, access_token_ciphertext,
      access_token_iv, institution_id, institution_name, status, created_by,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  )
    .bind(
      id,
      context.get("organizationId"),
      exchange.item_id,
      encrypted.ciphertext,
      encrypted.iv,
      optionalText(input.institutionId, 100),
      optionalText(input.institutionName, 200),
      context.get("authSession").user.id,
      now,
      now,
    )
    .run();
}

async function listConnections(database: D1Database, organizationId: string) {
  const result = await database
    .prepare(
      `SELECT item.id, item.institution_id, item.institution_name, item.status,
              item.error_code, item.last_synced_at, item.created_at, item.daily_sync,
              (SELECT status FROM job_runs WHERE connection_id = item.id
                ORDER BY created_at DESC, rowid DESC LIMIT 1) AS sync_status,
              COUNT(account.id) AS account_count
       FROM plaid_items AS item
       LEFT JOIN plaid_accounts AS account
         ON account.plaid_item_record_id = item.id
       WHERE item.organization_id = ?
       GROUP BY item.id ORDER BY item.created_at DESC`,
    )
    .bind(organizationId)
    .all<ConnectionRow>();
  return result.results;
}

async function listAccounts(database: D1Database, organizationId: string) {
  const result = await database
    .prepare(
      `SELECT account.id, account.name, account.official_name, account.mask,
              account.type, account.subtype, account.current_balance,
              account.available_balance, account.currency_code,
              item.institution_name
       FROM plaid_accounts AS account
       JOIN plaid_items AS item ON item.id = account.plaid_item_record_id
       WHERE account.organization_id = ? ORDER BY account.name ASC`,
    )
    .bind(organizationId)
    .all<AccountRow>();
  return result.results;
}

async function listTransactions(
  database: D1Database,
  filters: NonNullable<ReturnType<typeof financeListingFilters>>,
) {
  const result = await database
    .prepare(
      `SELECT txn.id, txn.name, txn.merchant_name,
              txn.amount, txn.currency_code,
              txn.transaction_date, txn.authorized_date,
              txn.category_primary, txn.category_detailed,
              txn.payment_channel, txn.pending,
              account.id AS account_id, account.name AS account_name,
              annotation.note AS annotation_note,
              annotation.expense_category_id AS annotation_expense_category_id,
              annotation.labels AS annotation_labels,
              annotation.reviewed AS annotation_reviewed
       FROM plaid_transactions AS txn
       JOIN plaid_accounts AS account
         ON account.id = txn.account_record_id
       LEFT JOIN finance_transaction_annotations AS annotation
         ON annotation.transaction_id = txn.id
       WHERE ${filters.where}
       ORDER BY txn.transaction_date DESC, txn.id DESC
       LIMIT ${transactionPageSize + 1}`,
    )
    .bind(...filters.bindings)
    .all<TransactionRow>();
  return result.results;
}

async function findItem(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT id, access_token_ciphertext, access_token_iv, cursor, status, institution_name
       FROM plaid_items
       WHERE id = ? AND organization_id = ? AND status <> 'disconnected'`,
    )
    .bind(id, organizationId)
    .first<
      PlaidItemRow & { status: string; institution_name: string | null }
    >();
}

async function findItemByPlaidId(database: D1Database, plaidItemId: string) {
  return database
    .prepare(
      `SELECT id, organization_id AS organizationId
       FROM plaid_items WHERE plaid_item_id = ?`,
    )
    .bind(plaidItemId)
    .first<{ id: string; organizationId: string }>();
}

function toConnection(row: ConnectionRow): FinanceConnection {
  return {
    accountCount: row.account_count,
    dailySync: Boolean(row.daily_sync),
    syncStatus: row.sync_status,
    createdAt: row.created_at,
    errorCode: row.error_code,
    id: row.id,
    institutionId: row.institution_id,
    institutionName: row.institution_name,
    lastSyncedAt: row.last_synced_at,
    status: row.status,
  };
}

function toAccount(row: AccountRow): FinanceAccount {
  return {
    availableBalance: row.available_balance,
    currencyCode: row.currency_code,
    currentBalance: row.current_balance,
    id: row.id,
    institutionName: row.institution_name,
    mask: row.mask,
    name: row.name,
    officialName: row.official_name,
    subtype: row.subtype,
    type: row.type,
  };
}

function toTransaction(
  row: TransactionRow,
  linkedEmails: LinkedEmail[],
): FinanceTransaction {
  return {
    accountId: row.account_id,
    accountName: row.account_name,
    amount: row.amount,
    annotation: {
      labels: parseLabels(row.annotation_labels),
      note: row.annotation_note ?? "",
      reviewed: Boolean(row.annotation_reviewed),
    },
    authorizedDate: row.authorized_date,
    categoryDetailed: row.category_detailed,
    categoryPrimary: row.category_primary,
    currencyCode: row.currency_code,
    expenseCategoryId: row.annotation_expense_category_id,
    id: row.id,
    linkedEmails,
    merchantName: row.merchant_name,
    name: row.name,
    paymentChannel: row.payment_channel,
    pending: Boolean(row.pending),
    transactionDate: row.transaction_date,
  };
}

function requireEncryptionKey(env: Bindings) {
  if (!env.PLAID_TOKEN_ENCRYPTION_KEY) {
    throw new PlaidApiError("Plaid is not configured.", "NOT_CONFIGURED", 503);
  }
  return env.PLAID_TOKEN_ENCRYPTION_KEY;
}

function isConfigured(env: Bindings) {
  return Boolean(
    env.PLAID_CLIENT_ID && env.PLAID_SECRET && env.PLAID_TOKEN_ENCRYPTION_KEY,
  );
}

function clientUserId(organizationId: string, userId: string) {
  return `${organizationId}:${userId}`.slice(0, 128);
}

async function financeInput(context: FinanceContext) {
  const input: unknown = await context.req.json().catch(() => null);
  return isRecord(input) ? input : null;
}

async function annotationInput(context: FinanceContext) {
  const input: unknown = await context.req.json().catch(() => null);
  return isRecord(input) ? (input as AnnotationInput) : null;
}

function normalizeAnnotation(
  input: AnnotationInput,
): FinanceTransactionAnnotation | null {
  if (
    typeof input.note !== "string" ||
    input.note.length > 2_000 ||
    !Array.isArray(input.labels) ||
    input.labels.length > 12 ||
    input.labels.some(
      (label) => typeof label !== "string" || label.trim().length > 50,
    ) ||
    typeof input.reviewed !== "boolean"
  ) {
    return null;
  }
  return {
    labels: [
      ...new Set(
        input.labels.map((label) => (label as string).trim()).filter(Boolean),
      ),
    ],
    note: input.note.trim(),
    reviewed: input.reviewed,
  };
}

function parseLabels(value: string | null) {
  if (!value) return [];
  try {
    const labels: unknown = JSON.parse(value);
    return Array.isArray(labels)
      ? labels.filter((label): label is string => typeof label === "string")
      : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is FinanceInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function optionalText(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim().length <= maxLength
    ? value.trim() || null
    : null;
}

export const finance = createFinanceRouter();
