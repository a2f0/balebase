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

/**
 * The browser's own connectivity: `navigator.onLine` and the window's
 * `online` and `offline` events. Accurate in browsers; a native shell supplies
 * the OS's instead, because an Android WebView can report offline while the
 * device is connected. Outside a browser it reports online and never changes.
 */
function browserNetworkStatusSource(): NetworkStatusSource {
  return {
    getOnline: () =>
      typeof navigator === "object" && typeof navigator.onLine === "boolean"
        ? navigator.onLine
        : true,
    subscribe(listener) {
      if (typeof window === "undefined") return () => {};
      const online = () => listener(true);
      const offline = () => listener(false);
      window.addEventListener("online", online);
      window.addEventListener("offline", offline);
      return () => {
        window.removeEventListener("online", online);
        window.removeEventListener("offline", offline);
      };
    },
  };
}

/**
 * Whether the device has a network. A request that fails while `online` is
 * true means the API is unreachable, not that the device went offline, so
 * work keeps retrying rather than waiting for a change that may never come.
 */
export class Network {
  readonly #source: NetworkStatusSource;

  constructor(source: NetworkStatusSource = browserNetworkStatusSource()) {
    this.#source = source;
  }

  get online() {
    return this.#source.getOnline();
  }

  /** Calls `listener` with each change; returns an unsubscribe. */
  readonly subscribe = (listener: (online: boolean) => void) =>
    this.#source.subscribe(listener);
}
