import type { ExpenseCategory } from "@balebase/validators/finance";

const hideEmptyCategoriesStorageKey = "balebase.finance-hide-empty-categories";

interface StorageReader {
  getItem(key: string): string | null;
}

interface StorageWriter {
  setItem(key: string, value: string): void;
}

/** Whether Categories hides categories with no transactions on this device. */
export function readHideEmptyCategories(storage?: StorageReader) {
  try {
    const availableStorage = storage ?? window.localStorage;
    return availableStorage.getItem(hideEmptyCategoriesStorageKey) === "true";
  } catch {
    return false;
  }
}

export function storeHideEmptyCategories(
  hide: boolean,
  storage?: StorageWriter,
) {
  try {
    const availableStorage = storage ?? window.localStorage;
    availableStorage.setItem(hideEmptyCategoriesStorageKey, String(hide));
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

/** A category's transactions dated in `year`, or all of them for null. */
export function periodTransactionCount(
  category: ExpenseCategory,
  year: number | null,
) {
  if (year === null) return category.transactionCount;
  return (
    category.transactionCountsByYear.find((entry) => entry.year === year)
      ?.transactionCount ?? 0
  );
}

/** The categories to list, and how many the switch hides, in a period. */
export function visibleCategories(
  categories: ExpenseCategory[],
  hideEmpty: boolean,
  year: number | null,
) {
  const shown = hideEmpty
    ? categories.filter((category) => periodTransactionCount(category, year))
    : categories;
  return { hidden: categories.length - shown.length, shown };
}
