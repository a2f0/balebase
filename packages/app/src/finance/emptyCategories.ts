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

/** The categories to list, and how many the switch hides. */
export function visibleCategories(
  categories: ExpenseCategory[],
  hideEmpty: boolean,
) {
  const shown = hideEmpty
    ? categories.filter((category) => category.transactionCount > 0)
    : categories;
  return { hidden: categories.length - shown.length, shown };
}
