/**
 * What the shell running the app provides. The web shell (packages/app-web)
 * leaves `native` unset; the Capacitor shell (packages/app-capacitor) fills it
 * in on a device, where the WebView's requests, emailed links, and downloads
 * need native handling.
 */
export interface AppHost {
  native?: NativeHost | undefined;
  captureError?:
    | ((error: unknown, source?: "boundary" | "uncaught-react") => void)
    | undefined;
}

export interface NativeHost {
  /**
   * The WebView origin sent as X-Balebase-Native-Origin: Request strips the
   * forbidden Origin header before Capacitor forwards it, and the API restores
   * Origin from this marker only when no browser Origin is present.
   */
  origin: string;
  /** The hosted app that emailed verification and reset links open. */
  appUrl: string;
  /** Saves or shares downloaded bytes; resolves false when the user cancels. */
  saveFile(blob: Blob, filename: string): Promise<boolean>;
  /**
   * Offers to save a password the person just signed in with to the system's
   * password manager. The WebView's own autofill never sees a sign-in succeed:
   * the form submits through native HTTP and the page never navigates.
   */
  savePassword(username: string, password: string): Promise<void>;
}

let host: AppHost = {};

/** Set once by renderApp before the first render. */
export function configureHost(next: AppHost) {
  host = next;
}

/** The native shell's services, or undefined in a browser. */
export function nativeHost() {
  return host.native;
}
