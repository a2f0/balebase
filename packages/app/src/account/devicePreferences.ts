import { hideEmptyCategoriesStorageKey } from "../finance/emptyCategories";
import { formTemplateViewStorageKey } from "../forms/formTemplateView";
import { sidebarWidthStorageKey } from "../workspace/sidebarWidth";
import { reloadThemePreference, themeStorageKey } from "./theme";

/**
 * The display settings this browser keeps for whoever is signed in. Offline
 * work, saved bank transactions, and Plaid's pending repair reports are not
 * settings: sign-out locks or keeps them as their own modules decide.
 */
const devicePreferenceKeys = [
  formTemplateViewStorageKey,
  hideEmptyCategoriesStorageKey,
  sidebarWidthStorageKey,
  themeStorageKey,
];

/** Forgets every display setting, so the next sign-in starts from the defaults. */
export function clearDevicePreferences() {
  try {
    for (const key of devicePreferenceKeys) window.localStorage.removeItem(key);
  } catch {
    // Signing out must still work when storage is disabled.
  }
  reloadThemePreference();
}
