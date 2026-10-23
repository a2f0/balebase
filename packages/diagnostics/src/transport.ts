import { makeFetchTransport } from "@sentry/browser";
import type { ClientOptions, Event } from "@sentry/core";
import { createSentryEventBudget } from "./budget";
import type { SentryConfig } from "./config";
import { fetchWithTimeout } from "./fetch";
import { sanitizeSentryEvent } from "./privacy";

export function createPrivateTransport(
  config: SentryConfig,
  admit = createSentryEventBudget(),
): ClientOptions["transport"] {
  return (options) => {
    const transport = makeFetchTransport(
      options,
      (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
        fetchWithTimeout(url, {
          ...init,
          credentials: "omit",
          referrerPolicy: "no-referrer",
        }),
    );
    return {
      flush: (timeout) => transport.flush(timeout),
      send(envelope) {
        const items: Array<[{ type: "event" }, Event]> = [];
        for (const [header, payload] of envelope[1]) {
          if (header.type !== "event") continue;
          const event = sanitizeSentryEvent(payload as Event, config);
          if (event && admit(event)) items.push([{ type: "event" }, event]);
        }
        return items.length
          ? transport.send([
              {
                event_id:
                  items[0]?.[1].event_id ??
                  crypto.randomUUID().replaceAll("-", ""),
                sent_at: new Date().toISOString(),
              },
              items,
            ])
          : Promise.resolve({});
      },
    };
  };
}
