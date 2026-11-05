import type { FinanceTransaction } from "@balebase/validators/finance";
import type { LinkedEmail } from "@balebase/validators/inbox";

/** A transaction as the listing and the device sync feed read it. */
export interface TransactionRow {
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

/** The columns of `TransactionRow`, over `txn`, `account`, and `annotation`. */
export const transactionRowColumns = `txn.id, txn.name, txn.merchant_name,
         txn.amount, txn.currency_code,
         txn.transaction_date, txn.authorized_date,
         txn.category_primary, txn.category_detailed,
         txn.payment_channel, txn.pending,
         account.id AS account_id, account.name AS account_name,
         annotation.note AS annotation_note,
         annotation.expense_category_id AS annotation_expense_category_id,
         annotation.labels AS annotation_labels,
         annotation.reviewed AS annotation_reviewed`;

/** The tables `transactionRowColumns` reads. */
export const transactionRowTables = `FROM plaid_transactions AS txn
  JOIN plaid_accounts AS account
    ON account.id = txn.account_record_id
  LEFT JOIN finance_transaction_annotations AS annotation
    ON annotation.transaction_id = txn.id`;

/** `TransactionRow`s; add a WHERE and an ORDER BY. */
export const transactionRowSelect = `SELECT ${transactionRowColumns}
  ${transactionRowTables}`;

export function toTransaction(
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
