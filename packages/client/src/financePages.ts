import type { FinanceFilters } from "./financeApi";
import { decodeRecordId } from "./workspacePaths";

export type FinancePage = "categories" | "connections" | "overview" | "reports";

export const financePages: {
  label: string;
  page: FinancePage;
  path: string;
}[] = [
  { label: "Overview", page: "overview", path: "/finance" },
  { label: "Reports", page: "reports", path: "/finance/reports" },
  { label: "Categories", page: "categories", path: "/finance/categories" },
  { label: "Connections", page: "connections", path: "/finance/connections" },
];

export function isFinancePath(pathname: string) {
  return pathname === "/finance" || pathname.startsWith("/finance/");
}

/** Expense category paths and unknown finance subpaths show the overview. */
export function financePageFor(pathname: string): FinancePage {
  return (
    financePages.find(({ path }) => path !== "/finance" && path === pathname)
      ?.page ?? "overview"
  );
}

const expenseCategoryPrefix = "/finance/expenses/category/";
/** The API never gives a category this slug. */
const uncategorizedSlug = "uncategorized";

type ExpenseCategoryFilters = Pick<
  FinanceFilters,
  "categorySlug" | "uncategorized"
>;

/** The overview path that bookmarks a category or the uncategorized bucket. */
export function financeOverviewPath({
  categorySlug,
  uncategorized,
}: ExpenseCategoryFilters) {
  if (uncategorized) return `${expenseCategoryPrefix}${uncategorizedSlug}`;
  if (categorySlug) {
    return `${expenseCategoryPrefix}${encodeURIComponent(categorySlug)}`;
  }
  return "/finance";
}

/** The category filters an overview path selects; plain /finance selects none. */
export function expenseCategoryFiltersFor(
  pathname: string,
): ExpenseCategoryFilters {
  const slug = pathname.startsWith(expenseCategoryPrefix)
    ? decodeRecordId(pathname.slice(expenseCategoryPrefix.length))
    : "";
  if (slug === uncategorizedSlug) {
    return { categorySlug: null, uncategorized: true };
  }
  return { categorySlug: slug || null, uncategorized: false };
}

export type ReportPreset =
  | "all-time"
  | "custom"
  | "last-12-months"
  | "last-month"
  | "this-month"
  | "this-year";

export const reportPresets: { label: string; preset: ReportPreset }[] = [
  { label: "This month", preset: "this-month" },
  { label: "Last month", preset: "last-month" },
  { label: "This year", preset: "this-year" },
  { label: "Last 12 months", preset: "last-12-months" },
  { label: "All time", preset: "all-time" },
  { label: "Custom", preset: "custom" },
];

export interface ReportRange {
  from: string | null;
  to: string | null;
}

/** Calendar ranges in the viewer's local time, as YYYY-MM-DD strings. */
export function presetRange(
  preset: Exclude<ReportPreset, "custom">,
  today: Date,
): ReportRange {
  const year = today.getFullYear();
  const month = today.getMonth();
  const end = isoDate(today);
  if (preset === "this-month") {
    return { from: isoDate(new Date(year, month, 1)), to: end };
  }
  if (preset === "last-month") {
    return {
      from: isoDate(new Date(year, month - 1, 1)),
      to: isoDate(new Date(year, month, 0)),
    };
  }
  if (preset === "this-year") {
    return { from: isoDate(new Date(year, 0, 1)), to: end };
  }
  if (preset === "last-12-months") {
    return { from: isoDate(new Date(year, month - 11, 1)), to: end };
  }
  return { from: null, to: null };
}

/** A category's share of the total as a 0–100 percentage for its bar. */
export function categoryShare(total: number, grandTotal: number) {
  if (total <= 0 || grandTotal <= 0) return 0;
  return Math.min(100, (total / grandTotal) * 100);
}

function isoDate(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function financeConnectionPath(id: string) {
  return `/finance/connections/${encodeURIComponent(id)}`;
}

export function financeTransactionPath(id: string) {
  return `/finance/transactions/${encodeURIComponent(id)}`;
}
