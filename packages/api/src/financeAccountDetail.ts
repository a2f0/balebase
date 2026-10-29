import {
  type FinanceAccountDetail,
  financeRoutes,
} from "@balebase/validators/finance";
import type { FinanceContext } from "./financeContext";
import { respond } from "./shared/respond";

/** How many of the newest transactions the account page lists. */
const recentTransactionLimit = 10;

interface AccountRow {
  available_balance: number | null;
  daily_sync: number;
  connection_id: string;
  connection_status: string;
  currency_code: string | null;
  current_balance: number | null;
  first_transaction_date: string | null;
  id: string;
  institution_id: string | null;
  institution_name: string | null;
  last_transaction_date: string | null;
  mask: string | null;
  name: string;
  official_name: string | null;
  plaid_account_id: string;
  plaid_item_id: string;
  subtype: string | null;
  transaction_count: number;
  type: string;
  updated_at: string;
}

interface TransactionRow {
  amount: number;
  currency_code: string | null;
  id: string;
  merchant_name: string | null;
  name: string;
  pending: number;
  transaction_date: string;
}

/** One account with its connection, imported history, and newest transactions. */
export async function accountDetail(context: FinanceContext) {
  const id = context.req.param("id") ?? "";
  const organizationId = context.get("organizationId");
  const database = context.env.DB;
  const [account, transactions] = await Promise.all([
    database
      .prepare(
        `SELECT account.id, account.plaid_account_id, account.name,
                account.official_name, account.mask, account.type,
                account.subtype, account.current_balance,
                account.available_balance, account.currency_code,
                account.updated_at, item.id AS connection_id,
                item.status AS connection_status, item.daily_sync, item.institution_id,
                item.institution_name, item.plaid_item_id,
                COUNT(txn.id) AS transaction_count,
                MIN(txn.transaction_date) AS first_transaction_date,
                MAX(txn.transaction_date) AS last_transaction_date
         FROM plaid_accounts AS account
         JOIN plaid_items AS item ON item.id = account.plaid_item_record_id
         LEFT JOIN plaid_transactions AS txn
           ON txn.account_record_id = account.id
          AND txn.source_status = 'active'
         WHERE account.id = ? AND account.organization_id = ?
         GROUP BY account.id`,
      )
      .bind(id, organizationId)
      .first<AccountRow>(),
    database
      .prepare(
        `SELECT id, name, merchant_name, amount, currency_code,
                transaction_date, pending
         FROM plaid_transactions
         WHERE organization_id = ? AND account_record_id = ?
           AND source_status = 'active'
         ORDER BY transaction_date DESC, id DESC
         LIMIT ?`,
      )
      .bind(organizationId, id, recentTransactionLimit)
      .all<TransactionRow>(),
  ]);
  if (!account) return context.json({ error: "Account not found." }, 404);
  return respond(context, financeRoutes.account, {
    account: toAccount(account),
    connection: {
      id: account.connection_id,
      dailySync: Boolean(account.daily_sync),
      institutionId: account.institution_id,
      institutionName: account.institution_name,
      plaidItemId: account.plaid_item_id,
      status: account.connection_status,
    },
    recentTransactions: transactions.results.map(toTransaction),
  });
}

function toAccount(row: AccountRow): FinanceAccountDetail["account"] {
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
    transactions: {
      count: row.transaction_count,
      firstDate: row.first_transaction_date,
      lastDate: row.last_transaction_date,
    },
    type: row.type,
    updatedAt: row.updated_at,
  };
}

function toTransaction(
  row: TransactionRow,
): FinanceAccountDetail["recentTransactions"][number] {
  return {
    amount: row.amount,
    currencyCode: row.currency_code,
    id: row.id,
    merchantName: row.merchant_name,
    name: row.name,
    pending: row.pending === 1,
    transactionDate: row.transaction_date,
  };
}
