import { nativeHost } from "../host";

// Trimmed as the SDK trims it, so anything built from it (such as a test
// fixture's offline store) keys the same saved data.
export const apiUrl = (
  import.meta.env.VITE_API_URL ?? "http://localhost:8787"
).replace(/\/+$/, "");

export const websiteUrl = (
  import.meta.env.VITE_WEBSITE_URL ?? "https://balebase.com"
).replace(/\/$/, "");

// Emailed verification/reset links must open the hosted app, not the local
// capacitor://localhost bundle. Web builds retain their current origin.
export function authCallbackUrl(path: string) {
  return new URL(path, nativeHost()?.appUrl ?? window.location.origin).href;
}
