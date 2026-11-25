export type FormTemplateView = "grid" | "list";

/** Every template list opens as a list until the person picks the grid. */
export const defaultFormTemplateView: FormTemplateView = "list";

// Sign-out clears it with the other display settings (../account/devicePreferences.ts).
export const formTemplateViewStorageKey = "balebase.form-template-view";

interface StorageReader {
  getItem(key: string): string | null;
}

interface StorageWriter {
  setItem(key: string, value: string): void;
}

export function readFormTemplateView(
  storage?: StorageReader,
): FormTemplateView {
  try {
    const availableStorage = storage ?? window.localStorage;
    const storedView = availableStorage.getItem(formTemplateViewStorageKey);
    return storedView === "grid" || storedView === "list"
      ? storedView
      : defaultFormTemplateView;
  } catch {
    return defaultFormTemplateView;
  }
}

export function storeFormTemplateView(
  view: FormTemplateView,
  storage?: StorageWriter,
) {
  try {
    const availableStorage = storage ?? window.localStorage;
    availableStorage.setItem(formTemplateViewStorageKey, view);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}
