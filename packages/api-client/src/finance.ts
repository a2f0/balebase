import type {
  FinanceTransactionAnnotation,
  financeRoutes,
  PlaidLinkDiagnostics,
} from "@balebase/validators/finance";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  listing: endpoint<typeof financeRoutes.listing>({
    method: "GET",
    path: "/api/finance",
    response: "json",
  }),
  createLinkToken: endpoint<typeof financeRoutes.createLinkToken>({
    method: "POST",
    path: "/api/finance/link-token",
    response: "json",
  }),
  createUpdateLinkToken: endpoint<typeof financeRoutes.createUpdateLinkToken>({
    method: "POST",
    path: "/api/finance/connections/:id/link-token",
    response: "json",
  }),
  reportLinkDiagnostics: endpoint<typeof financeRoutes.reportLinkDiagnostics>({
    method: "POST",
    path: "/api/finance/link-diagnostics",
    body: "json",
    response: "empty",
  }),
  exchangePublicToken: endpoint<typeof financeRoutes.exchangePublicToken>({
    method: "POST",
    path: "/api/finance/exchange",
    body: "json",
    response: "json",
  }),
  startSync: endpoint<typeof financeRoutes.startSync>({
    method: "POST",
    path: "/api/finance/connections/:id/sync-jobs",
    response: "json",
  }),
  syncStatus: endpoint<typeof financeRoutes.syncStatus>({
    method: "GET",
    path: "/api/finance/connections/:id/sync-status",
    response: "json",
  }),
  updateSyncSettings: endpoint<typeof financeRoutes.updateSyncSettings>({
    method: "PATCH",
    path: "/api/finance/connections/:id/sync-settings",
    body: "json",
    response: "json",
  }),
  connection: endpoint<typeof financeRoutes.connection>({
    method: "GET",
    path: "/api/finance/connections/:id",
    response: "json",
  }),
  institutionHealth: endpoint<typeof financeRoutes.institutionHealth>({
    method: "GET",
    path: "/api/finance/connections/:id/institution-health",
    response: "json",
  }),
  disconnectConnection: endpoint<typeof financeRoutes.disconnectConnection>({
    method: "DELETE",
    path: "/api/finance/connections/:id",
    response: "empty",
  }),
  deleteConnectionData: endpoint<typeof financeRoutes.deleteConnectionData>({
    method: "DELETE",
    path: "/api/finance/connections/:id/data",
    response: "empty",
  }),
  account: endpoint<typeof financeRoutes.account>({
    method: "GET",
    path: "/api/finance/accounts/:id",
    response: "json",
  }),
  searchTransactions: endpoint<typeof financeRoutes.searchTransactions>({
    method: "GET",
    path: "/api/finance/transactions",
    response: "json",
  }),
  transaction: endpoint<typeof financeRoutes.transaction>({
    method: "GET",
    path: "/api/finance/transactions/:id",
    response: "json",
  }),
  connectionActivity: endpoint<typeof financeRoutes.connectionActivity>({
    method: "GET",
    path: "/api/finance/connections/:id/activity",
    response: "json",
  }),
  transactionActivity: endpoint<typeof financeRoutes.transactionActivity>({
    method: "GET",
    path: "/api/finance/transactions/:id/activity",
    response: "json",
  }),
  updateTransactionAnnotation: endpoint<
    typeof financeRoutes.updateTransactionAnnotation
  >({
    method: "PATCH",
    path: "/api/finance/transactions/:id/annotation",
    body: "json",
    response: "json",
  }),
  setTransactionCategory: endpoint<typeof financeRoutes.setTransactionCategory>(
    {
      method: "PUT",
      path: "/api/finance/transactions/:id/category",
      body: "json",
      response: "json",
    },
  ),
  listCategories: endpoint<typeof financeRoutes.listCategories>({
    method: "GET",
    path: "/api/finance/categories",
    response: "json",
  }),
  createCategory: endpoint<typeof financeRoutes.createCategory>({
    method: "POST",
    path: "/api/finance/categories",
    body: "json",
    response: "json",
  }),
  addDefaultCategories: endpoint<typeof financeRoutes.addDefaultCategories>({
    method: "POST",
    path: "/api/finance/categories/defaults",
    response: "json",
  }),
  renameCategory: endpoint<typeof financeRoutes.renameCategory>({
    method: "PATCH",
    path: "/api/finance/categories/:id",
    body: "json",
    response: "json",
  }),
  deleteCategory: endpoint<typeof financeRoutes.deleteCategory>({
    method: "DELETE",
    path: "/api/finance/categories/:id",
    response: "empty",
  }),
  expenseReport: endpoint<typeof financeRoutes.expenseReport>({
    method: "GET",
    path: "/api/finance/reports/expenses",
    response: "json",
  }),
};

export interface FinanceFilters {
  accountIds: string[];
  /** One expense category's transactions, from its bookmarkable path. */
  categorySlug: string | null;
  year: number | null;
  uncategorized: boolean;
}

export function financeApi(transport: Transport) {
  return {
    ...financeSyncApi(transport),
    /** Connections, accounts, categories, and a page of transactions. */
    data(filters?: FinanceFilters, cursor?: string) {
      return transport.call(endpoints.listing, {
        query: {
          accountId: filters?.accountIds,
          year: filters?.year ? String(filters.year) : undefined,
          uncategorized: filters?.uncategorized ? "true" : undefined,
          category: filters?.categorySlug || undefined,
          cursor: cursor || undefined,
        },
      });
    },
    createPlaidLinkToken() {
      return transport.call(endpoints.createLinkToken);
    },
    createPlaidUpdateLinkToken(connectionId: string) {
      return transport.call(endpoints.createUpdateLinkToken, {
        params: { id: connectionId },
      });
    },
    reportPlaidLinkDiagnostics(diagnostics: PlaidLinkDiagnostics) {
      return transport.call(endpoints.reportLinkDiagnostics, {
        body: diagnostics,
      });
    },
    exchangePlaidPublicToken(
      publicToken: string,
      institution: { id: string | null; name: string | null },
    ) {
      return transport.call(endpoints.exchangePublicToken, {
        body: {
          institutionId: institution.id,
          institutionName: institution.name,
          publicToken,
        },
      });
    },
    account(id: string) {
      return transport.call(endpoints.account, { params: { id } });
    },
    connection(id: string) {
      return transport.call(endpoints.connection, { params: { id } });
    },
    disconnectConnection(id: string) {
      return transport.call(endpoints.disconnectConnection, {
        params: { id },
      });
    },
    deleteConnectionData(id: string) {
      return transport.call(endpoints.deleteConnectionData, {
        params: { id },
      });
    },
    transaction(id: string) {
      return transport.call(endpoints.transaction, { params: { id } });
    },
    transactionActivity(id: string, cursor?: string) {
      return transport.call(endpoints.transactionActivity, {
        params: { id },
        query: { cursor },
      });
    },
    updateTransactionAnnotation(
      id: string,
      annotation: FinanceTransactionAnnotation,
    ) {
      return transport.call(endpoints.updateTransactionAnnotation, {
        body: annotation,
        params: { id },
      });
    },
    /** Finds transactions by name, merchant, or amount; recent ones when empty. */
    async searchTransactions(query: string) {
      const body = await transport.call(endpoints.searchTransactions, {
        query: { q: query.trim() || undefined },
      });
      return body.transactions;
    },
    setTransactionCategory(id: string, categoryId: string | null) {
      return transport.call(endpoints.setTransactionCategory, {
        body: { categoryId },
        params: { id },
      });
    },
    expenseCategories() {
      return transport.call(endpoints.listCategories);
    },
    createExpenseCategory(name: string) {
      return transport.call(endpoints.createCategory, { body: { name } });
    },
    renameExpenseCategory(id: string, name: string) {
      return transport.call(endpoints.renameCategory, {
        body: { name },
        params: { id },
      });
    },
    deleteExpenseCategory(id: string) {
      return transport.call(endpoints.deleteCategory, { params: { id } });
    },
    addDefaultExpenseCategories() {
      return transport.call(endpoints.addDefaultCategories);
    },
    /** Totals for an inclusive range; null bounds are open. */
    expenseReport(range: { from: string | null; to: string | null }) {
      return transport.call(endpoints.expenseReport, {
        query: { from: range.from || undefined, to: range.to || undefined },
      });
    },
  };
}

/** A connection's sync, settings, health, and history. */
function financeSyncApi(transport: Transport) {
  return {
    connectionActivity(id: string, cursor?: string) {
      return transport.call(endpoints.connectionActivity, {
        params: { id },
        query: { cursor },
      });
    },
    startSync(id: string) {
      return transport.call(endpoints.startSync, { params: { id } });
    },
    syncStatus(id: string) {
      return transport.call(endpoints.syncStatus, { params: { id } });
    },
    /** Plaid's live health for a connection's bank, across all its users. */
    institutionHealth(connectionId: string) {
      return transport.call(endpoints.institutionHealth, {
        params: { id: connectionId },
      });
    },
    updateSyncSettings(id: string, dailySync: boolean) {
      return transport.call(endpoints.updateSyncSettings, {
        params: { id },
        body: { dailySync },
      });
    },
  };
}
