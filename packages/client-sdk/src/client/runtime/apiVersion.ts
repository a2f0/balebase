// The API names its version in this header on every response.
const apiVersionHeader = "API-Version";

/**
 * The API version from the latest response that named one. Every request the
 * SDK sends records it, whatever its status, so a deploy while a client is
 * open shows up with the next response. A response that names none, such as
 * one from a proxy in front of the API, leaves the last version known.
 */
export class ApiVersion {
  #current: string | null = null;
  readonly #listeners = new Set<() => void>();

  /** Null until a response names a version. */
  get current() {
    return this.#current;
  }

  /** Keeps the version `response` names; the SDK calls it for each one. */
  record(response: Response) {
    const version = response.headers.get(apiVersionHeader);
    if (version === null || version === this.#current) return;
    this.#current = version;
    for (const listener of this.#listeners) listener();
  }

  /** Calls `listener` after each change; returns an unsubscribe. */
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
}
