import { describe, expect, it } from "bun:test";
import { api } from "../shared/apiClient";
import { apiUrl } from "../shared/config";
import { installFetch } from "../testing/fetch";

const respond = installFetch();

describe("finance API", () => {
  it("requests expense reports for a range, or all time without one", async () => {
    const requested = await captureRequests(async () => {
      await api.finance.expenseReport({ from: "2026-08-01", to: "2026-08-31" });
      await api.finance.expenseReport({ from: null, to: null });
      await api.finance.expenseReport({ from: "2026-01-01", to: null });
    });
    expect(requested).toEqual([
      `${apiUrl}/api/finance/reports/expenses?from=2026-08-01&to=2026-08-31`,
      `${apiUrl}/api/finance/reports/expenses`,
      `${apiUrl}/api/finance/reports/expenses?from=2026-01-01`,
    ]);
  });

  it("combines account, category, year, expense, and pagination filters", async () => {
    const cursor = JSON.stringify({ date: "2025-08-01", id: "txn/1" });
    const requested = await captureRequests(async () => {
      await api.finance.data(
        {
          accountIds: ["checking/1", "savings"],
          categorySlug: "meals-2",
          year: 2025,
          uncategorized: true,
        },
        cursor,
      );
    });
    const url = new URL(requested[0] ?? "");
    expect(url.pathname).toBe("/api/finance");
    expect(url.searchParams.getAll("accountId")).toEqual([
      "checking/1",
      "savings",
    ]);
    expect(url.searchParams.get("category")).toBe("meals-2");
    expect(url.searchParams.get("year")).toBe("2025");
    expect(url.searchParams.get("uncategorized")).toBe("true");
    expect(url.searchParams.get("cursor")).toBe(cursor);
  });
});

async function captureRequests(run: () => Promise<void>) {
  const urls: string[] = [];
  respond(async (url) => {
    urls.push(url.href);
    return Response.json({});
  });
  await run();
  return urls;
}
