/**
 * What the shell running the app provides. The web shell (packages/app-web)
 * leaves `native` unset; the Capacitor shell (packages/app-capacitor) fills it
 * in on a device, where the WebView's requests, emailed links, and downloads
 * need native handling.
 */
export interface AppHost {
  native?: NativeHost | undefined;
  /**
   * Device connectivity, where the shell knows better than the WebView;
   * otherwise the browser's (`shared/network.ts`).
   */
  network?: NetworkStatusSource | undefined;
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

/**
 * A source of connectivity: a synchronous best-known value, and changes. A
 * source that reads asynchronously starts from a guess and corrects it
 * through its first change.
 */
export interface NetworkStatusSource {
  getOnline(): boolean;
  /** Calls `listener` with each change; returns an unsubscribe. */
  subscribe(listener: (online: boolean) => void): () => void;
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

/** The shell's connectivity source, or undefined to use the browser's. */
export function networkSource() {
  return host.network;
}
