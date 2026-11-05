import { financeRoutes } from "@balebase/validators/finance";
import { financeLimits } from "@balebase/validators/rules";
import {
  type LinkedEmailRow,
  linkedTransactionEmailsStatement,
  toLinkedEmail,
} from "../inbox/inboundEmailLinks";
import { decodeCursor, encodeCursor } from "../shared/cursorPagination";
import { respond } from "../shared/respond";
import type { FinanceContext } from "./financeContext";
import {
  type TransactionRow,
  toTransaction,
  transactionRowColumns,
  transactionRowTables,
} from "./financeTransactionRows";

interface ChangedRow extends TransactionRow {
  source_status: string;
  sync_revision: number;
}

interface Change {
  id: string;
  revision: number;
  /** Absent for a deleted transaction. */
  row?: ChangedRow;
}

/**
 * The organization's transaction changes after a cursor, in revision order
 * (migration 0092 explains the revisions). The counter, the changed rows,
 * the deletions, and their linked emails are read in one batch, so a page is
 * one consistent snapshot; anything written later takes a higher revision and
 * arrives on a later page. A transaction changed again while a device pages
 * moves past its old place and is read once more, never skipped.
 */
export async function transactionChanges(context: FinanceContext) {
  const organizationId = context.get("organizationId");
  const raw = context.req.query("cursor");
  const after =
    raw === undefined
      ? { epoch: undefined, id: "", revision: 0 }
      : parseCursor(raw);
  if (!after) return context.json({ error: "Invalid sync cursor." }, 400);
  const limit = financeLimits.syncPage;
  const database = context.env.DB;
  const page = {
    bindings: [organizationId, after.revision, after.id],
    sql: `SELECT id FROM plaid_transactions
          WHERE organization_id = ? AND (sync_revision, id) > (?, ?)
          ORDER BY sync_revision, id LIMIT ${limit + 1}`,
  };
  const [head, rows, deleted, emails] = await database.batch([
    database
      .prepare(
        "SELECT revision, epoch FROM finance_sync_revisions WHERE organization_id = ?",
      )
      .bind(organizationId),
    database
      .prepare(
        `SELECT txn.sync_revision, txn.source_status, ${transactionRowColumns}
         ${transactionRowTables}
         WHERE txn.organization_id = ? AND (txn.sync_revision, txn.id) > (?, ?)
         ORDER BY txn.sync_revision, txn.id LIMIT ${limit + 1}`,
      )
      .bind(...page.bindings),
    database
      .prepare(
        `SELECT transaction_id AS id, revision FROM finance_sync_tombstones
         WHERE organization_id = ? AND (revision, transaction_id) > (?, ?)
         ORDER BY revision, transaction_id LIMIT ${limit + 1}`,
      )
      .bind(...page.bindings),
    linkedTransactionEmailsStatement(database, organizationId, page),
  ]);
  const current = head?.results[0] as
    | { epoch: string; revision: number }
    | undefined;
  // A cursor from another epoch (a restore since) or ahead of the counter
  // describes history this database does not have: start over.
  if (
    raw !== undefined &&
    (after.epoch !== current?.epoch ||
      after.revision > (current?.revision ?? 0))
  )
    return startOver(context, organizationId);
  const changes = [
    ...((rows?.results ?? []) as ChangedRow[]).map((row) => ({
      id: row.id,
      revision: row.sync_revision,
      row,
    })),
    ...((deleted?.results ?? []) as { id: string; revision: number }[]),
  ].sort(byRevision);
  const taken: Change[] = changes.slice(0, limit);
  const last = taken.at(-1);
  const emailsByTransaction = Map.groupBy(
    (emails?.results ?? []) as LinkedEmailRow[],
    ({ target_id }) => target_id,
  );
  // Within a page the latest change of a transaction wins.
  const latest = new Map(taken.map((change) => [change.id, change]));
  const kept = [...latest.values()].flatMap(({ row }) =>
    row?.source_status === "active" ? [row] : [],
  );
  return respond(context, financeRoutes.transactionChanges, {
    cursor:
      last && current
        ? encodeCursor(`${current.epoch}.${last.revision}`, last.id)
        : (raw ?? null),
    more: changes.length > limit,
    organizationId,
    removedIds: [...latest.values()]
      .filter(({ row }) => row?.source_status !== "active")
      .map(({ id }) => id),
    reset: false,
    transactions: kept.map((row) =>
      toTransaction(
        row,
        (emailsByTransaction.get(row.id) ?? []).map(toLinkedEmail),
      ),
    ),
  });
}

/** Tells a device its cursor is for history this database does not have. */
function startOver(context: FinanceContext, organizationId: string) {
  return respond(context, financeRoutes.transactionChanges, {
    cursor: null,
    more: false,
    organizationId,
    removedIds: [],
    reset: true,
    transactions: [],
  });
}

function byRevision(a: Change, b: Change) {
  return a.revision - b.revision || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function parseCursor(value: string) {
  const cursor = decodeCursor(value, 512);
  const place = cursor && /^([0-9a-f]{1,64})\.(\d{1,15})$/.exec(cursor[0]);
  if (!cursor || !place?.[1] || !place[2] || cursor[1].length > 200)
    return null;
  return { epoch: place[1], id: cursor[1], revision: Number(place[2]) };
}
