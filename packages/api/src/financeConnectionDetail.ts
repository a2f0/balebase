import type { FinanceContext } from "./financeContext";

interface ConnectionRow {
  created_at: string;
  created_by_email: string | null;
  created_by_name: string | null;
  disconnected_at: string | null;
  error_code: string | null;
  error_message: string | null;
  first_transaction_date: string | null;
  id: string;
  institution_id: string | null;
  institution_name: string | null;
  last_synced_at: string | null;
  last_transaction_date: string | null;
  plaid_item_id: string;
  status: string;
  transaction_count: number;
}

interface AccountRow {
  available_balance: number | null;
  currency_code: string | null;
  current_balance: number | null;
  id: string;
  mask: string | null;
  name: string;
  official_name: string | null;
  plaid_account_id: string;
  subtype: string | null;
  transaction_count: number;
  type: string;
}

/**
 * One connection with its accounts, imported history, and the Plaid
 * identifiers that Plaid support asks for. The access token never leaves D1.
 */
export async function connectionDetail(context: FinanceContext) {
  const id = context.req.param("id") ?? "";
  const organizationId = context.get("organizationId");
  const database = context.env.DB;
  const [connection, accounts] = await Promise.all([
    database
      .prepare(
        `SELECT item.id, item.plaid_item_id, item.institution_id,
                item.institution_name, item.status, item.error_code,
                item.error_message, item.created_at, item.last_synced_at,
                item.disconnected_at, creator.name AS created_by_name,
                creator.email AS created_by_email,
                COUNT(txn.id) AS transaction_count,
                MIN(txn.transaction_date) AS first_transaction_date,
                MAX(txn.transaction_date) AS last_transaction_date
         FROM plaid_items AS item
         LEFT JOIN user AS creator ON creator.id = item.created_by
         LEFT JOIN plaid_transactions AS txn
           ON txn.plaid_item_record_id = item.id
          AND txn.source_status = 'active'
         WHERE item.id = ? AND item.organization_id = ?
         GROUP BY item.id`,
      )
      .bind(id, organizationId)
      .first<ConnectionRow>(),
    database
      .prepare(
        `SELECT account.id, account.plaid_account_id, account.name,
                account.official_name, account.mask, account.type,
                account.subtype, account.current_balance,
                account.available_balance, account.currency_code,
                COUNT(txn.id) AS transaction_count
         FROM plaid_accounts AS account
         LEFT JOIN plaid_transactions AS txn
           ON txn.account_record_id = account.id
          AND txn.source_status = 'active'
         WHERE account.plaid_item_record_id = ? AND account.organization_id = ?
         GROUP BY account.id
         ORDER BY account.name COLLATE NOCASE, account.id`,
      )
      .bind(id, organizationId)
      .all<AccountRow>(),
  ]);
  if (!connection) {
    return context.json({ error: "Connection not found." }, 404);
  }
  return context.json({
    accounts: accounts.results.map(toAccount),
    connection: toConnection(connection),
  });
}

function toConnection(row: ConnectionRow) {
  return {
    createdAt: row.created_at,
    createdBy:
      row.created_by_email === null
        ? null
        : { email: row.created_by_email, name: row.created_by_name ?? "" },
    disconnectedAt: row.disconnected_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    id: row.id,
    institutionId: row.institution_id,
    institutionName: row.institution_name,
    lastSyncedAt: row.last_synced_at,
    plaidItemId: row.plaid_item_id,
    status: row.status,
    transactions: {
      count: row.transaction_count,
      firstDate: row.first_transaction_date,
      lastDate: row.last_transaction_date,
    },
  };
}

function toAccount(row: AccountRow) {
  return {
    availableBalance: row.available_balance,
    currencyCode: row.currency_code,
    currentBalance: row.current_balance,
    id: row.id,
    mask: row.mask,
    name: row.name,
    officialName: row.official_name,
    plaidAccountId: row.plaid_account_id,
    subtype: row.subtype,
    transactionCount: row.transaction_count,
    type: row.type,
  };
}
