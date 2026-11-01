import type { ActivityCausation } from "../shared/systemActivity";
import type { Bindings } from "../types";
import {
  carriedOverStatement,
  removedTransactionsStatement,
} from "./financeProviderActivity";
import {
  type PlaidAccount,
  PlaidApiError,
  type PlaidRequest,
  type PlaidTransaction,
  type TransactionsSyncResponse,
} from "./plaid";
import { decryptToken } from "./plaidCrypto";

export interface PlaidItemRow {
  access_token_ciphertext: string;
  access_token_iv: string;
  cursor: string | null;
  id: string;
}

/** One bounded page per queue delivery; the job checkpoints its cursor separately.
 * Replaying a page preserves local identifiers, annotations, and categories.
 * `causation` names the page in the provider events it records. */
export async function syncPlaidPage(
  env: Bindings,
  organizationId: string,
  item: PlaidItemRow,
  requestPlaid: PlaidRequest,
  causation: ActivityCausation,
) {
  const accessToken = await decryptAccessToken(env, organizationId, item);
  const response = await requestPlaid<TransactionsSyncResponse>(
    env,
    "/transactions/sync",
    {
      access_token: accessToken,
      count: 100,
      ...(item.cursor ? { cursor: item.cursor } : {}),
      options: {
        include_original_description: false,
        personal_finance_category_version: "v2",
      },
    },
  );
  await persistPage(env.DB, organizationId, item.id, response, causation);
  return response;
}

/**
 * The accounts and transactions of disconnected connections that a page
 * takes over. Their writes wait for the page's end, to commit with the
 * event that records them; the maps let later rows of the page find them.
 */
interface CarryOver {
  /** Each carried account's ID, and the write that moves it. */
  accounts: Map<string, D1PreparedStatement>;
  /** Plaid's ID of each carried account, to its ID. */
  plaidAccountIds: Map<string, string>;
  /** Plaid's ID of each carried transaction, to its ID. */
  plaidTransactionIds: Map<string, string>;
  /** Each carried transaction's ID, and the write that moves it. */
  transactions: Map<string, D1PreparedStatement>;
}

async function persistPage(
  database: D1Database,
  organizationId: string,
  itemId: string,
  page: TransactionsSyncResponse,
  causation: ActivityCausation,
) {
  const carryOver: CarryOver = {
    accounts: new Map(),
    plaidAccountIds: new Map(),
    plaidTransactionIds: new Map(),
    transactions: new Map(),
  };
  const accountIds = new Map<string, string>();
  for (const account of page.accounts) {
    accountIds.set(
      account.account_id,
      await upsertAccount(database, organizationId, itemId, account, carryOver),
    );
  }
  for (const transaction of [...page.added, ...page.modified]) {
    const accountId = accountIds.get(transaction.account_id);
    if (!accountId) {
      throw new Error("Plaid returned a transaction without its account.");
    }
    await upsertTransaction(
      database,
      organizationId,
      itemId,
      accountId,
      transaction,
      carryOver,
    );
  }
  if (carryOver.accounts.size > 0 || carryOver.transactions.size > 0) {
    await database.batch([
      carriedOverStatement(database, causation, organizationId, itemId, {
        accountIds: [...carryOver.accounts.keys()],
        transactionIds: [...carryOver.transactions.keys()],
      }),
      ...carryOver.accounts.values(),
      ...carryOver.transactions.values(),
    ]);
  }
  if (page.removed.length === 0) return;
  const removed = page.removed.map(
    ({ transaction_id: transactionId }) => transactionId,
  );
  await database.batch([
    removedTransactionsStatement(
      database,
      causation,
      organizationId,
      itemId,
      removed,
    ),
    database
      .prepare(
        `UPDATE plaid_transactions
         SET source_status = 'removed', updated_at = ?
         WHERE plaid_item_record_id = ?
           AND plaid_transaction_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(new Date().toISOString(), itemId, JSON.stringify(removed)),
  ]);
}

async function upsertAccount(
  database: D1Database,
  organizationId: string,
  itemId: string,
  account: PlaidAccount,
  carryOver: CarryOver,
) {
  const existingId =
    carryOver.plaidAccountIds.get(account.account_id) ??
    (
      await database
        .prepare(
          `SELECT id FROM plaid_accounts
           WHERE plaid_item_record_id = ? AND plaid_account_id = ?`,
        )
        .bind(itemId, account.account_id)
        .first<{ id: string }>()
    )?.id;
  const candidates = existingId
    ? []
    : await disconnectedAccountCandidates(
        database,
        organizationId,
        itemId,
        account,
        [...carryOver.accounts.keys()],
      );
  const carriedId = candidates.length === 1 ? candidates[0]?.id : undefined;
  const id = existingId ?? carriedId ?? crypto.randomUUID();
  const upsert = database
    .prepare(
      `INSERT INTO plaid_accounts
       (id, plaid_account_id, organization_id, plaid_item_record_id, name,
        official_name, mask, type, subtype, current_balance, available_balance,
        currency_code, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         plaid_account_id = excluded.plaid_account_id,
         plaid_item_record_id = excluded.plaid_item_record_id,
         name = excluded.name, official_name = excluded.official_name,
         mask = excluded.mask, type = excluded.type,
         subtype = excluded.subtype,
         current_balance = excluded.current_balance,
         available_balance = excluded.available_balance,
         currency_code = excluded.currency_code,
         updated_at = excluded.updated_at`,
    )
    .bind(
      id,
      account.account_id,
      organizationId,
      itemId,
      account.name,
      account.official_name,
      account.mask,
      account.type,
      account.subtype,
      account.balances.current,
      account.balances.available,
      currency(account),
      new Date().toISOString(),
    );
  if (carriedId || carryOver.accounts.has(id)) {
    carryOver.accounts.set(id, upsert);
    carryOver.plaidAccountIds.set(account.account_id, id);
  } else {
    await upsert.run();
  }
  return id;
}

async function disconnectedAccountCandidates(
  database: D1Database,
  organizationId: string,
  itemId: string,
  account: PlaidAccount,
  carried: string[],
) {
  const result = await database
    .prepare(
      `SELECT account.id
       FROM plaid_accounts AS account
       JOIN plaid_items AS archived_item
         ON archived_item.id = account.plaid_item_record_id
       JOIN plaid_items AS current_item ON current_item.id = ?
       WHERE account.organization_id = ?
         AND archived_item.status = 'disconnected'
         AND COALESCE(archived_item.institution_id, '') =
             COALESCE(current_item.institution_id, '')
         AND COALESCE(archived_item.institution_name, '') =
             COALESCE(current_item.institution_name, '')
         AND COALESCE(account.mask, '') = COALESCE(?, '')
         AND account.type = ?
         AND COALESCE(account.subtype, '') = COALESCE(?, '')
         AND account.id NOT IN (SELECT value FROM json_each(?))
       LIMIT 2`,
    )
    .bind(
      itemId,
      organizationId,
      account.mask,
      account.type,
      account.subtype,
      JSON.stringify(carried),
    )
    .all<{ id: string }>();
  return result.results;
}

async function upsertTransaction(
  database: D1Database,
  organizationId: string,
  itemId: string,
  accountId: string,
  transaction: PlaidTransaction,
  carryOver: CarryOver,
) {
  const source = async (plaidTransactionId: string) =>
    carryOver.plaidTransactionIds.get(plaidTransactionId) ??
    (await findSourceTransaction(database, itemId, plaidTransactionId))?.id;
  const existingId = await source(transaction.transaction_id);
  const pendingId =
    !existingId && transaction.pending_transaction_id
      ? await source(transaction.pending_transaction_id)
      : undefined;
  const candidates =
    existingId || pendingId
      ? []
      : await disconnectedTransactionCandidates(
          database,
          organizationId,
          accountId,
          transaction,
          [...carryOver.transactions.keys()],
        );
  const carriedId = candidates.length === 1 ? candidates[0]?.id : undefined;
  const id = existingId ?? pendingId ?? carriedId ?? crypto.randomUUID();
  const upsert = database
    .prepare(
      `INSERT INTO plaid_transactions
       (id, plaid_transaction_id, organization_id, plaid_item_record_id,
        account_record_id, name, merchant_name, amount, currency_code,
        transaction_date,
        authorized_date, category_primary, category_detailed, payment_channel,
        pending, pending_transaction_id, source_status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
       ON CONFLICT(id) DO UPDATE SET
         plaid_transaction_id = excluded.plaid_transaction_id,
         plaid_item_record_id = excluded.plaid_item_record_id,
         account_record_id = excluded.account_record_id, name = excluded.name,
         merchant_name = excluded.merchant_name, amount = excluded.amount,
         currency_code = excluded.currency_code,
         transaction_date = excluded.transaction_date,
         authorized_date = excluded.authorized_date,
         category_primary = excluded.category_primary,
         category_detailed = excluded.category_detailed,
         payment_channel = excluded.payment_channel,
         pending = excluded.pending,
         pending_transaction_id = excluded.pending_transaction_id,
         source_status = 'active', updated_at = excluded.updated_at`,
    )
    .bind(
      id,
      transaction.transaction_id,
      organizationId,
      itemId,
      accountId,
      transaction.name,
      transaction.merchant_name,
      transaction.amount,
      transaction.iso_currency_code ?? transaction.unofficial_currency_code,
      transaction.date,
      transaction.authorized_date,
      transaction.personal_finance_category?.primary ?? null,
      transaction.personal_finance_category?.detailed ?? null,
      transaction.payment_channel,
      transaction.pending ? 1 : 0,
      transaction.pending_transaction_id,
      new Date().toISOString(),
    );
  if (carriedId || carryOver.transactions.has(id)) {
    carryOver.transactions.set(id, upsert);
    carryOver.plaidTransactionIds.set(transaction.transaction_id, id);
  } else {
    await upsert.run();
  }
}

function findSourceTransaction(
  database: D1Database,
  itemId: string,
  plaidTransactionId: string,
) {
  return database
    .prepare(
      `SELECT id FROM plaid_transactions
       WHERE plaid_item_record_id = ? AND plaid_transaction_id = ?`,
    )
    .bind(itemId, plaidTransactionId)
    .first<{ id: string }>();
}

async function disconnectedTransactionCandidates(
  database: D1Database,
  organizationId: string,
  accountId: string,
  transaction: PlaidTransaction,
  carried: string[],
) {
  const result = await database
    .prepare(
      `SELECT txn.id
       FROM plaid_transactions AS txn
       JOIN plaid_items AS item ON item.id = txn.plaid_item_record_id
       WHERE txn.organization_id = ? AND txn.account_record_id = ?
         AND item.status = 'disconnected'
         AND txn.source_status = 'active'
         AND txn.transaction_date = ?
         AND COALESCE(txn.authorized_date, '') = COALESCE(?, '')
         AND txn.amount = ?
         AND COALESCE(txn.currency_code, '') = COALESCE(?, '')
         AND txn.name = ?
         AND COALESCE(txn.merchant_name, '') = COALESCE(?, '')
         AND txn.pending = ?
         AND txn.id NOT IN (SELECT value FROM json_each(?))
       LIMIT 2`,
    )
    .bind(
      organizationId,
      accountId,
      transaction.date,
      transaction.authorized_date,
      transaction.amount,
      transaction.iso_currency_code ?? transaction.unofficial_currency_code,
      transaction.name,
      transaction.merchant_name,
      transaction.pending ? 1 : 0,
      JSON.stringify(carried),
    )
    .all<{ id: string }>();
  return result.results;
}

async function decryptAccessToken(
  env: Bindings,
  organizationId: string,
  item: PlaidItemRow,
) {
  if (!env.PLAID_TOKEN_ENCRYPTION_KEY) {
    throw new PlaidApiError("Plaid is not configured.", "NOT_CONFIGURED", 503);
  }
  return decryptToken(
    {
      ciphertext: item.access_token_ciphertext,
      iv: item.access_token_iv,
    },
    env.PLAID_TOKEN_ENCRYPTION_KEY,
    `${organizationId}:${item.id}`,
  );
}

function currency(account: PlaidAccount) {
  return (
    account.balances.iso_currency_code ??
    account.balances.unofficial_currency_code
  );
}
