import type { JobRun } from "@balebase/validators/adminJobs";
import type { FinanceTransaction } from "@balebase/validators/finance";
import { createRoot } from "react-dom/client";
import { AdminJobHistory } from "../src/admin/AdminJobHistory";
import { Finance } from "../src/finance/Finance";

function run(index: number): JobRun {
  return {
    runId: `run-${index}`,
    jobId: "test-job",
    status: "succeeded",
    source: "scheduled",
    requestedBy: null,
    requestedByName: null,
    requestedByEmail: null,
    organizationId: null,
    connectionId: null,
    attempts: 1,
    createdAt: new Date(Date.UTC(2026, 9, 27, 12, 0, -index)).toISOString(),
    startedAt: null,
    finishedAt: null,
    availableAt: "2026-10-27T12:00:00.000Z",
    durationMs: 100,
    error: null,
    errorCode: null,
    output: null,
  };
}

function transaction(index: number): FinanceTransaction {
  return {
    id: `txn-${index}`,
    name: `Transaction ${index}`,
    accountId: "checking",
    accountName: "Checking",
    amount: 10,
    currencyCode: "USD",
    merchantName: null,
    transactionDate: "2026-10-27",
    authorizedDate: null,
    categoryPrimary: null,
    categoryDetailed: null,
    paymentChannel: null,
    expenseCategoryId: null,
    linkedEmails: [],
    pending: false,
    annotation: { labels: [], note: "", reviewed: false },
  };
}

/** Transactions the Finance fixture holds: three of the overview's pages. */
export function financeRows(pageSize: number) {
  return pageSize > 1 ? 750 : 3;
}

/**
 * Finance keeps every transaction on the device and shows 250 at a time, so
 * its fixture serves the summary and a change feed (in pages of 100, to
 * download in parts), and the page grows as it scrolls.
 */
function financeResponse(url: URL, total: number) {
  if (!url.pathname.endsWith("/transactions/changes"))
    return Response.json({
      accounts: [],
      categories: [],
      connections: [],
      configured: true,
      nextCursor: null,
      organizationId: "organization",
      transactions: [],
      userId: "person",
    });
  const offset = Number(url.searchParams.get("cursor") ?? 0);
  const end = Math.min(offset + 100, total);
  return Response.json({
    cursor: String(end),
    more: end < total,
    organizationId: "organization",
    removedIds: [],
    reset: false,
    transactions: Array.from({ length: end - offset }, (_, i) =>
      transaction(offset + i),
    ),
    userId: "person",
  });
}

export function mount(
  element: HTMLElement,
  mode: "jobs" | "finance",
  pageSize: number,
) {
  const total = pageSize * 3;
  const fetchPage = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (mode === "finance") return financeResponse(url, financeRows(pageSize));
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const nextCursor =
      offset + pageSize < total ? String(offset + pageSize) : null;
    const indexes = Array.from({ length: pageSize }, (_, i) => offset + i);
    return Response.json({ runs: indexes.map(run), nextCursor });
  };
  window.fetch = Object.assign(fetchPage, { preconnect: () => {} });
  createRoot(element).render(
    mode === "jobs" ? (
      <AdminJobHistory jobs={[]} initialRun={undefined} />
    ) : (
      <Finance pathname="/finance" onNavigate={() => {}} />
    ),
  );
}
