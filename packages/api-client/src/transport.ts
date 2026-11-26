import type {
  Route,
  RouteInput,
  RouteOutput,
} from "@balebase/validators/route";
import { ApiError } from "./ApiError";
import type { Endpoint } from "./endpoint";

export interface ApiClientOptions {
  /** The API origin, such as `https://api.balebase.com`. */
  baseUrl: string;
  /** Sends each request. The default looks the global fetch up per call. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /**
   * Ends every request when it aborts, as well as at each route's own
   * timeout. Usually set through `withSignal`.
   */
  signal?: AbortSignal | undefined;
}

/** A route's input, optional when every part of it is. */
export type RouteArgs<R extends Route> =
  Record<never, never> extends RouteInput<R>
    ? [input?: RouteInput<R>]
    : [input: RouteInput<R>];

interface LooseInput {
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
}

/** Sends requests for the contract's routes. Area clients build on it. */
export class Transport {
  readonly #options: ApiClientOptions;
  readonly #fetch: NonNullable<ApiClientOptions["fetch"]>;

  constructor(options: ApiClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * This transport with every request also ending when `signal` aborts, such
   * as when the screen that asked for it goes away. Each route's own timeout
   * still applies, so a request ends at whichever comes first. A subclass
   * returns its own kind by overriding it with `optionsWithSignal`.
   */
  withSignal(signal: AbortSignal): Transport {
    return new Transport(this.optionsWithSignal(signal));
  }

  /** These options, with `signal` ending requests as well as any signal before. */
  protected optionsWithSignal(signal: AbortSignal): ApiClientOptions {
    const current = this.#options.signal;
    return {
      ...this.#options,
      signal: current ? AbortSignal.any([current, signal]) : signal,
    };
  }

  /** The absolute URL of a route, for links and downloads the browser opens. */
  url<R extends Route>(route: Endpoint<R>, ...[input]: RouteArgs<R>) {
    const { params = {}, query = {} } = (input ?? {}) as LooseInput;
    const path = route.path.replace(/:(\w+)/g, (_, name: string) => {
      const value = params[name];
      if (value === undefined)
        throw new Error(`Missing path parameter ${name}.`);
      return encodeURIComponent(value);
    });
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      for (const item of [value].flat()) {
        if (item !== undefined && item !== null)
          search.append(key, String(item));
      }
    }
    return `${this.#options.baseUrl}${path}${search.size ? `?${search}` : ""}`;
  }

  /** Sends a route's request. A response that isn't OK throws an ApiError. */
  async call<R extends Route>(
    route: Endpoint<R>,
    ...args: RouteArgs<R>
  ): Promise<RouteOutput<R>> {
    const { body } = (args[0] ?? {}) as LooseInput;
    const init: RequestInit = {
      credentials: route.credentials ?? "include",
      method: route.method,
    };
    const signals: AbortSignal[] = [];
    if (this.#options.signal) signals.push(this.#options.signal);
    if (route.timeoutMs !== undefined)
      signals.push(AbortSignal.timeout(route.timeoutMs));
    const [only] = signals;
    if (signals.length > 1) init.signal = AbortSignal.any(signals);
    else if (only) init.signal = only;
    if (route.body === "form") init.body = body as FormData;
    else if (route.body === "file") {
      const file = body as Blob;
      init.body = file;
      init.headers = {
        "Content-Type": file.type || "application/octet-stream",
      };
    } else if (route.body === "json") {
      init.body = JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    const response = await this.#fetch(this.url(route, ...args), init);
    if (!response.ok) throw await ApiError.from(response);
    if (route.response === "file") return response as RouteOutput<R>;
    if (route.response === "empty" || response.status === 204)
      return undefined as RouteOutput<R>;
    return (await response.json()) as RouteOutput<R>;
  }
}
