import { describe, expect, it } from "bun:test";
import type {
  FinanceConnection,
  FinanceData,
} from "@balebase/validators/finance";
import { renderToStaticMarkup } from "react-dom/server";
import { FinanceView } from "./Finance";
import { initialFilters } from "./useFinanceData";
import type { FinancePage } from "./workspace/workspacePaths";

const emptyData: FinanceData = {
  accounts: [],
  categories: [],
  configured: true,
  connections: [],
  nextCursor: null,
  transactions: [],
};

const populatedData: FinanceData = {
  ...emptyData,
  accounts: [
    {
      availableBalance: null,
      currencyCode: "USD",
      currentBalance: 100,
      id: "account-1",
      institutionName: "Bank",
      mask: "1234",
      name: "Checking",
      officialName: null,
      subtype: "checking",
      type: "depository",
    },
  ],
};

const connection = (
  overrides: Partial<FinanceConnection> = {},
): FinanceConnection => ({
  accountCount: 1,
  dailySync: false,
  syncStatus: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  errorCode: null,
  id: "connection-1",
  institutionId: null,
  institutionName: "Bank",
  lastSyncedAt: null,
  status: "active",
  ...overrides,
});

function renderFinance(
  data: FinanceData | undefined,
  options: {
    error?: string;
    loadError?: string;
    notice?: string;
    page?: FinancePage;
  } = {},
) {
  return renderToStaticMarkup(
    <FinanceView
      filters={initialFilters}
      loading={false}
      loadingMore={false}
      refreshing={false}
      loadError={options.loadError}
      loadMoreError={undefined}
      onFiltersChange={() => undefined}
      onLoadMore={async () => false}
      busy={false}
      data={data}
      error={options.error}
      notice={options.notice}
      onAnnotate={async () => undefined}
      onCategorize={async () => undefined}
      onConnect={async () => undefined}
      onDeleteData={async () => undefined}
      onDisconnect={async () => undefined}
      onNavigate={() => undefined}
      onReload={async () => undefined}
      onSync={async () => undefined}
      page={options.page ?? "overview"}
    />,
  );
}

describe("Finance overview notices", () => {
  it("waits for account data before showing the account notice", () => {
    expect(renderFinance(undefined)).not.toContain("Before you add an account");
  });

  it("shows the account notice when there are no accounts", () => {
    expect(renderFinance(emptyData)).toContain("Before you add an account");
  });

  it("hides the account notice after an account is added", () => {
    expect(renderFinance(populatedData)).not.toContain(
      "Before you add an account",
    );
  });

  it("preserves setup, error, and success banners after an account is added", () => {
    const markup = renderFinance(
      { ...populatedData, configured: false },
      { error: "Could not sync", notice: "Account connected" },
    );

    expect(markup).not.toContain("Before you add an account");
    expect(markup).toContain("Plaid setup is incomplete");
    expect(markup).toContain("Could not sync");
    expect(markup).toContain("Account connected");
  });
});

describe("Finance connections", () => {
  it("shows a pending daily sync, disables duplicate syncs, and permits disconnect", () => {
    const markup = renderFinance(
      {
        ...populatedData,
        connections: [connection({ dailySync: true, syncStatus: "running" })],
      },
      { page: "connections" },
    );
    expect(markup).toContain("Daily sync");
    expect(markup).toContain("Running");
    expect(markup).toContain("Syncing…");
    expect(markup.match(/<button[^>]*disabled=""/g)).toHaveLength(1);
  });

  it("offers retry for an interrupted disconnect and prevents syncing it", () => {
    const markup = renderFinance(
      {
        ...populatedData,
        connections: [connection({ status: "disconnecting" })],
      },
      { page: "connections" },
    );
    expect(markup).toContain("Retry disconnect");
    expect(markup.match(/<button[^>]*disabled=""/g)).toHaveLength(1);
  });
  it("lists connections on their own tab instead of the overview", () => {
    const data = { ...populatedData, connections: [connection()] };

    expect(renderFinance(data)).not.toContain("Sync now");
    const markup = renderFinance(data, { page: "connections" });
    expect(markup).toContain("Sync now");
    expect(markup).toContain("Connect bank");
    expect(markup).toContain('href="/finance/connections/connection-1"');
  });

  it("explains an empty connections tab", () => {
    const markup = renderFinance(emptyData, { page: "connections" });

    expect(markup).toContain("No banks connected yet");
    expect(markup).toContain("Before you add an account");
  });

  it("offers a retry instead of loading forever after a failed load", () => {
    const markup = renderFinance(undefined, {
      loadError: "Could not load finances.",
      page: "connections",
    });

    expect(markup).toContain("Could not load finances.");
    expect(markup).toContain("Retry");
    expect(markup).not.toContain("Loading connections");
  });

  it("flags connections that stopped syncing on the overview", () => {
    expect(
      renderFinance({ ...populatedData, connections: [connection()] }),
    ).not.toContain("stopped syncing");
    expect(
      renderFinance({
        ...populatedData,
        connections: [
          connection({ errorCode: "ITEM_LOGIN_REQUIRED", status: "error" }),
        ],
      }),
    ).toContain("Bank stopped syncing");
    expect(
      renderFinance({
        ...populatedData,
        connections: [
          connection({ status: "error" }),
          connection({ id: "connection-2", status: "error" }),
        ],
      }),
    ).toContain("2 connections stopped syncing");
  });
});
