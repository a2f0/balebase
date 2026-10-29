import type { FinanceContext } from "./financeContext";
import { decodeCursor } from "./shared/cursorPagination";

/** Filters are applied before pagination, including for older imported years. */
export function financeListingFilters(context: FinanceContext) {
  const accountIds = context.req.queries("accountId") ?? [];
  const year = context.req.query("year");
  const uncategorized = context.req.query("uncategorized");
  const category = context.req.query("category");
  // Clients before 0.1.52, including installed mobile apps, filter by id.
  const categoryId = context.req.query("categoryId");
  const cursor = parseCursor(context.req.query("cursor"));
  if (
    accountIds.length > 200 ||
    accountIds.some((id) => !id || id.length > 200) ||
    (year !== undefined && !/^[1-9]\d{3}$/.test(year)) ||
    (uncategorized !== undefined && uncategorized !== "true") ||
    (category !== undefined && (!category || category.length > 200)) ||
    (categoryId !== undefined && (!categoryId || categoryId.length > 200)) ||
    cursor === false
  ) {
    return null;
  }
  const conditions = [
    "txn.organization_id = ?",
    "txn.source_status = 'active'",
  ];
  const bindings: (string | number)[] = [context.get("organizationId")];
  if (accountIds.length) {
    conditions.push(
      "txn.account_record_id IN (SELECT value FROM json_each(?))",
    );
    bindings.push(JSON.stringify(accountIds));
  }
  if (year) {
    conditions.push("txn.transaction_date BETWEEN ? AND ?");
    bindings.push(`${year}-01-01`, `${year}-12-31`);
  }
  if (uncategorized) {
    // Match the uncategorized expense bucket in financeReports.ts.
    conditions.push(
      "annotation.expense_category_id IS NULL",
      "txn.pending = 0",
      "txn.amount > 0",
      "COALESCE(txn.category_primary, '') NOT IN ('TRANSFER_OUT', 'LOAN_PAYMENTS')",
    );
  }
  if (category) {
    // An unknown slug matches nothing rather than failing the whole listing.
    conditions.push(
      `annotation.expense_category_id = (
         SELECT id FROM finance_expense_categories
         WHERE organization_id = txn.organization_id AND slug = ?
       )`,
    );
    bindings.push(category);
  }
  if (categoryId) {
    conditions.push("annotation.expense_category_id = ?");
    bindings.push(categoryId);
  }
  if (cursor) {
    conditions.push("(txn.transaction_date, txn.id) < (?, ?)");
    bindings.push(...cursor);
  }
  return { bindings, where: conditions.join(" AND ") };
}

function parseCursor(value: string | undefined) {
  if (value === undefined) return null;
  const cursor = decodeCursor(value, "date", 512);
  return cursor &&
    /^\d{4}-\d{2}-\d{2}$/.test(cursor[0]) &&
    cursor[1].length <= 200
    ? cursor
    : false;
}
