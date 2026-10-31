import { z } from "zod";
import { ActivityPageSchema, ActivityQuerySchema } from "./activity";
import {
  calendarDate,
  lineName,
  optionalText,
  RecordIdSchema,
  requiredText,
} from "./fields";
import { LinkedEmailSchema } from "./inbox";
import { route } from "./route";
import { financeLimits } from "./rules";

const FinanceSyncStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
const FinanceSyncJobSchema = z.object({
  id: z.string(),
  status: FinanceSyncStatusSchema,
  source: z.enum(["manual", "daily"]),
  added: z.number(),
  modified: z.number(),
  removed: z.number(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
});
export type FinanceSyncJob = z.infer<typeof FinanceSyncJobSchema>;

const FinanceConnectionSchema = z.object({
  accountCount: z.number(),
  dailySync: z.boolean(),
  syncStatus: FinanceSyncStatusSchema.nullable(),
  createdAt: z.string(),
  errorCode: z.string().nullable(),
  id: z.string(),
  institutionId: z.string().nullable(),
  institutionName: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  status: z.string(),
});
export type FinanceConnection = z.infer<typeof FinanceConnectionSchema>;

/** An account's own fields, as every finance page shows them. */
const AccountFieldsSchema = z.object({
  availableBalance: z.number().nullable(),
  currencyCode: z.string().nullable(),
  currentBalance: z.number().nullable(),
  id: z.string(),
  mask: z.string().nullable(),
  name: z.string(),
  officialName: z.string().nullable(),
  subtype: z.string().nullable(),
  type: z.string(),
});

const FinanceAccountSchema = AccountFieldsSchema.extend({
  institutionName: z.string().nullable(),
});
export type FinanceAccount = z.infer<typeof FinanceAccountSchema>;

/** Active imported transactions and their date range. */
const ImportedHistorySchema = z.object({
  count: z.number(),
  firstDate: z.string().nullable(),
  lastDate: z.string().nullable(),
});

/** A connection's own account, with the identifier Plaid support asks for. */
const FinanceConnectionAccountSchema = AccountFieldsSchema.extend({
  plaidAccountId: z.string(),
  transactionCount: z.number(),
});
export type FinanceConnectionAccount = z.infer<
  typeof FinanceConnectionAccountSchema
>;

const FinanceConnectionDetailSchema = z.object({
  accounts: z.array(FinanceConnectionAccountSchema),
  connection: z.object({
    dailySync: z.boolean(),
    syncJob: FinanceSyncJobSchema.nullable(),
    createdAt: z.string(),
    createdBy: z.object({ email: z.string(), name: z.string() }).nullable(),
    disconnectedAt: z.string().nullable(),
    errorCode: z.string().nullable(),
    /** Plaid's explanation; older failures have only a code. */
    errorMessage: z.string().nullable(),
    id: z.string(),
    institutionId: z.string().nullable(),
    institutionName: z.string().nullable(),
    lastSyncedAt: z.string().nullable(),
    plaidItemId: z.string(),
    status: z.string(),
    transactions: ImportedHistorySchema,
  }),
});
export type FinanceConnectionDetail = z.infer<
  typeof FinanceConnectionDetailSchema
>;

/**
 * Plaid's live health for one product at an institution, across every Plaid
 * customer. Rates are percentages of recent requests; null means Plaid did not
 * report it, which is unknown rather than healthy. `status` is Plaid's coarse
 * (deprecated) HEALTHY, DEGRADED, or DOWN.
 */
const InstitutionProductHealthSchema = z.object({
  institutionErrorRate: z.number().nullable(),
  lastStatusChange: z.string().nullable(),
  plaidErrorRate: z.number().nullable(),
  status: z.string().nullable(),
  successRate: z.number().nullable(),
});
export type InstitutionProductHealth = z.infer<
  typeof InstitutionProductHealthSchema
>;

const FinanceInstitutionHealthSchema = z.object({
  /** When Plaid was asked; repeated checks within minutes share one answer. */
  checkedAt: z.string(),
  institutionId: z.string().nullable(),
  institutionName: z.string().nullable(),
  /** Logging in, including Update login repairs. */
  logins: InstitutionProductHealthSchema.nullable(),
  /** Refreshing transactions for connections that are already logged in. */
  transactions: InstitutionProductHealthSchema.extend({
    refreshInterval: z.string().nullable(),
  }).nullable(),
});
export type FinanceInstitutionHealth = z.infer<
  typeof FinanceInstitutionHealthSchema
>;

const FinanceTransactionAnnotationSchema = z.object({
  labels: z.array(z.string()),
  note: z.string(),
  reviewed: z.boolean(),
});
export type FinanceTransactionAnnotation = z.infer<
  typeof FinanceTransactionAnnotationSchema
>;

const FinanceTransactionSchema = z.object({
  accountId: z.string(),
  accountName: z.string(),
  amount: z.number(),
  annotation: FinanceTransactionAnnotationSchema,
  authorizedDate: z.string().nullable(),
  categoryDetailed: z.string().nullable(),
  categoryPrimary: z.string().nullable(),
  currencyCode: z.string().nullable(),
  /** The transaction's single expense category, if one is assigned. */
  expenseCategoryId: z.string().nullable(),
  id: z.string(),
  /** Inbox emails, such as receipts, linked to this transaction. */
  linkedEmails: z.array(LinkedEmailSchema),
  merchantName: z.string().nullable(),
  name: z.string(),
  paymentChannel: z.string().nullable(),
  pending: z.boolean(),
  transactionDate: z.string(),
});
export type FinanceTransaction = z.infer<typeof FinanceTransactionSchema>;

const FinanceAccountDetailSchema = z.object({
  account: AccountFieldsSchema.extend({
    plaidAccountId: z.string(),
    transactions: ImportedHistorySchema,
    /** When a Plaid sync last wrote this account's balances. */
    updatedAt: z.string(),
  }),
  connection: FinanceConnectionDetailSchema.shape.connection.pick({
    id: true,
    institutionId: true,
    institutionName: true,
    plaidItemId: true,
    status: true,
    dailySync: true,
  }),
  /** The ten newest active transactions. */
  recentTransactions: z.array(
    FinanceTransactionSchema.pick({
      amount: true,
      currencyCode: true,
      id: true,
      merchantName: true,
      name: true,
      pending: true,
      transactionDate: true,
    }),
  ),
});
export type FinanceAccountDetail = z.infer<typeof FinanceAccountDetailSchema>;

/** Stored Plaid fields returned only by the transaction detail request. */
const FinanceTransactionSourceSchema = z.object({
  accountMask: z.string().nullable(),
  accountOfficialName: z.string().nullable(),
  accountSubtype: z.string().nullable(),
  accountType: z.string(),
  institutionName: z.string().nullable(),
  pendingTransactionId: z.string().nullable(),
  plaidTransactionId: z.string(),
  updatedAt: z.string(),
});
export type FinanceTransactionSource = z.infer<
  typeof FinanceTransactionSourceSchema
>;

const FinanceTransactionMatchSchema = z.object({
  accountName: z.string(),
  amount: z.number(),
  currencyCode: z.string().nullable(),
  id: z.string(),
  merchantName: z.string().nullable(),
  name: z.string(),
  transactionDate: z.string(),
});
export type FinanceTransactionMatch = z.infer<
  typeof FinanceTransactionMatchSchema
>;

const ExpenseCategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Unique in the organization; changes when the category is renamed. */
  slug: z.string(),
  transactionCount: z.number(),
});
export type ExpenseCategory = z.infer<typeof ExpenseCategorySchema>;

const ExpenseCategoryTotalSchema = z.object({
  /** Null for the uncategorized bucket. */
  id: z.string().nullable(),
  name: z.string(),
  total: z.number(),
  transactionCount: z.number(),
});
export type ExpenseCategoryTotal = z.infer<typeof ExpenseCategoryTotalSchema>;

const ExpenseReportCurrencySchema = z.object({
  categories: z.array(ExpenseCategoryTotalSchema),
  currency: z.string(),
  excludedTransfers: z.object({
    total: z.number(),
    transactionCount: z.number(),
  }),
  total: z.number(),
  transactionCount: z.number(),
});
export type ExpenseReportCurrency = z.infer<typeof ExpenseReportCurrencySchema>;

const ExpenseReportSchema = z.object({
  currencies: z.array(ExpenseReportCurrencySchema),
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type ExpenseReport = z.infer<typeof ExpenseReportSchema>;

const FinanceDataSchema = z.object({
  accounts: z.array(FinanceAccountSchema),
  categories: z.array(ExpenseCategorySchema),
  configured: z.boolean(),
  connections: z.array(FinanceConnectionSchema),
  nextCursor: z.string().nullable(),
  transactions: z.array(FinanceTransactionSchema),
});
export type FinanceData = z.infer<typeof FinanceDataSchema>;

const FinanceListingQuerySchema = z.object({
  /** Repeated once per selected account. */
  accountId: z.union([z.string(), z.array(z.string())]).optional(),
  /** An expense category's slug. */
  category: z.string().optional(),
  /** Clients before 0.1.52, including installed mobile apps, filter by id. */
  categoryId: z.string().optional(),
  cursor: z.string().optional(),
  uncategorized: z.literal("true").optional(),
  year: z.string().optional(),
});

const categoryNameRule = `Category names need 1 to ${financeLimits.categoryName} characters.`;

const CategoryNameSchema = z.object(
  { name: lineName(financeLimits.categoryName, categoryNameRule) },
  { error: categoryNameRule },
);
const CategoriesResponseSchema = z.object({
  categories: z.array(ExpenseCategorySchema),
});

const searchRule = `Searches need ${financeLimits.search} characters or fewer.`;

const reportRangeRule = "Use YYYY-MM-DD dates with from on or before to.";
/** An empty day leaves that end of the range open. */
const ReportDaySchema = z
  .union([z.literal(""), calendarDate(reportRangeRule)])
  .optional();
const ReportRangeSchema = z
  .object({ from: ReportDaySchema, to: ReportDaySchema })
  .refine(({ from, to }) => !from || !to || from <= to, reportRangeRule);

const linkText = (max: number) => z.string().max(max).nullable();

/** What Plaid Link reported for one session, so failures inside Link (which
 * never reach the API otherwise) can be read from the API logs. */
const PlaidLinkDiagnosticsSchema = z.object({
  connectionId: linkText(100),
  error: z
    .object({
      displayMessage: linkText(1000),
      errorCode: linkText(100),
      errorMessage: linkText(1000),
      errorType: linkText(100),
    })
    .nullable(),
  events: z
    .array(
      z.object({
        errorCode: linkText(100),
        errorMessage: linkText(1000),
        errorType: linkText(100),
        eventName: linkText(100),
        exitStatus: linkText(100),
        requestId: linkText(100),
        timestamp: linkText(100),
        viewName: linkText(100),
      }),
    )
    .max(200),
  institutionId: linkText(100),
  institutionName: linkText(200),
  linkSessionId: linkText(100),
  mode: z.enum(["create", "update"]),
  oauthResume: z.boolean(),
  outcome: z.enum(["exit", "success"]),
  requestId: linkText(100),
  status: linkText(100),
});
export type PlaidLinkDiagnostics = z.infer<typeof PlaidLinkDiagnosticsSchema>;

export const financeRoutes = {
  listing: route({
    method: "GET",
    path: "/api/finance",
    query: FinanceListingQuerySchema,
    response: FinanceDataSchema,
  }),
  createLinkToken: route({
    method: "POST",
    path: "/api/finance/link-token",
    response: z.object({ expiration: z.string(), linkToken: z.string() }),
  }),
  /** Plaid Link update mode: repairs a connection's login on the same Item,
   * so its access token, sync cursor, and imported records stay as they are. */
  createUpdateLinkToken: route({
    method: "POST",
    path: "/api/finance/connections/:id/link-token",
    response: z.object({ expiration: z.string(), linkToken: z.string() }),
  }),
  reportLinkDiagnostics: route({
    method: "POST",
    path: "/api/finance/link-diagnostics",
    body: PlaidLinkDiagnosticsSchema,
    response: "empty",
  }),
  exchangePublicToken: route({
    method: "POST",
    path: "/api/finance/exchange",
    body: z.object({
      institutionId: optionalText(z.string().trim().max(100)),
      institutionName: optionalText(z.string().trim().max(200)),
      publicToken: requiredText(1000),
    }),
    response: z.object({ connectionId: z.string() }),
  }),
  syncConnection: route({
    method: "POST",
    path: "/api/finance/connections/:id/sync",
    response: z.object({
      added: z.number(),
      modified: z.number(),
      removed: z.number(),
    }),
  }),
  startSync: route({
    method: "POST",
    path: "/api/finance/connections/:id/sync-jobs",
    response: FinanceSyncJobSchema,
  }),
  syncStatus: route({
    method: "GET",
    path: "/api/finance/connections/:id/sync-status",
    response: z.object({
      connection: FinanceConnectionDetailSchema.shape.connection.pick({
        status: true,
        errorCode: true,
        errorMessage: true,
        lastSyncedAt: true,
        syncJob: true,
      }),
    }),
  }),
  updateSyncSettings: route({
    method: "PATCH",
    path: "/api/finance/connections/:id/sync-settings",
    body: z.object({ dailySync: z.boolean() }).strict(),
    response: z.object({ dailySync: z.boolean() }),
  }),
  connection: route({
    method: "GET",
    path: "/api/finance/connections/:id",
    response: FinanceConnectionDetailSchema,
  }),
  /** Plaid's live health for the connection's bank: is it a wider outage? */
  institutionHealth: route({
    method: "GET",
    path: "/api/finance/connections/:id/institution-health",
    response: FinanceInstitutionHealthSchema,
  }),
  disconnectConnection: route({
    method: "DELETE",
    path: "/api/finance/connections/:id",
    response: "empty",
  }),
  deleteConnectionData: route({
    method: "DELETE",
    path: "/api/finance/connections/:id/data",
    response: "empty",
  }),
  account: route({
    method: "GET",
    path: "/api/finance/accounts/:id",
    response: FinanceAccountDetailSchema,
  }),
  searchTransactions: route({
    method: "GET",
    path: "/api/finance/transactions",
    query: z.object({
      q: z.string().trim().max(financeLimits.search, searchRule).optional(),
    }),
    response: z.object({
      transactions: z.array(FinanceTransactionMatchSchema),
    }),
  }),
  transaction: route({
    method: "GET",
    path: "/api/finance/transactions/:id",
    response: z.object({
      categories: z.array(ExpenseCategorySchema),
      source: FinanceTransactionSourceSchema,
      transaction: FinanceTransactionSchema,
    }),
  }),
  transactionActivity: route({
    method: "GET",
    path: "/api/finance/transactions/:id/activity",
    query: ActivityQuerySchema,
    response: ActivityPageSchema,
  }),
  updateTransactionAnnotation: route({
    method: "PATCH",
    path: "/api/finance/transactions/:id/annotation",
    body: z.object({
      /** Trimmed, without blanks or repeats. */
      labels: z
        .array(z.string().trim().max(financeLimits.annotationLabel))
        .max(financeLimits.annotationLabels)
        .transform((labels) => [...new Set(labels.filter(Boolean))]),
      note: z.string().max(financeLimits.annotationNote).trim(),
      reviewed: z.boolean(),
    }),
    response: z.object({ annotation: FinanceTransactionAnnotationSchema }),
  }),
  setTransactionCategory: route({
    method: "PUT",
    path: "/api/finance/transactions/:id/category",
    body: z.object({ categoryId: RecordIdSchema.nullable() }),
    response: z.object({ expenseCategoryId: z.string().nullable() }),
  }),
  listCategories: route({
    method: "GET",
    path: "/api/finance/categories",
    response: CategoriesResponseSchema,
  }),
  createCategory: route({
    method: "POST",
    path: "/api/finance/categories",
    body: CategoryNameSchema,
    response: z.object({ category: ExpenseCategorySchema }),
  }),
  addDefaultCategories: route({
    method: "POST",
    path: "/api/finance/categories/defaults",
    response: CategoriesResponseSchema,
  }),
  renameCategory: route({
    method: "PATCH",
    path: "/api/finance/categories/:id",
    body: CategoryNameSchema,
    response: z.object({
      category: ExpenseCategorySchema.omit({ transactionCount: true }),
    }),
  }),
  deleteCategory: route({
    method: "DELETE",
    path: "/api/finance/categories/:id",
    response: "empty",
  }),
  expenseReport: route({
    method: "GET",
    path: "/api/finance/reports/expenses",
    query: ReportRangeSchema,
    response: ExpenseReportSchema,
  }),
};
