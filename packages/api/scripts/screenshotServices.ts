import type { TransactionsSyncResponse } from "../src/finance/plaid";
import { consumeJobs } from "../src/jobs/jobWorker";
import type { Bindings } from "../src/types";
import { continuity } from "./continuity";

/**
 * In-process stand-ins for the services the screenshot API would otherwise
 * call: Cloudflare Images, email, the finance sync queue, and Plaid. Nothing
 * here leaves the process.
 */

/** Messages the API sent, so the seed can follow signing links. */
export interface SentMessage {
  to: string;
  text: string;
}

export function emailOutbox() {
  const messages: SentMessage[] = [];
  const binding = {
    send: async (message: { to: { email: string }; text: string }) => {
      messages.push({ text: message.text, to: message.to.email });
      return { messageId: `screenshot-message-${messages.length}` };
    },
  } as unknown as SendEmail;
  return { binding, messages };
}

/**
 * Cloudflare Images without the transforms: uploads keep their bytes and
 * thumbnails are the full image, which the browser scales. Only JPEG, the
 * format of every continuity photo, is understood.
 */
export function passThroughImages() {
  const bytesOf = (stream: ReadableStream<Uint8Array>) =>
    new Response(stream).bytes();
  return {
    info: async (stream: ReadableStream<Uint8Array>) => {
      const bytes = await bytesOf(stream);
      return { fileSize: bytes.length, format: "image/jpeg", ...jpeg(bytes) };
    },
    input: (stream: ReadableStream<Uint8Array>) => {
      const bytes = bytesOf(stream);
      const transformer = {
        transform: () => transformer,
        output: async () => {
          const image = await bytes;
          return {
            contentType: () => "image/jpeg",
            image: () => new Blob([image]).stream(),
            response: () =>
              new Response(image, {
                headers: { "content-type": "image/jpeg" },
              }),
          };
        },
      };
      return transformer;
    },
  } as unknown as ImagesBinding;
}

/** A JPEG's pixel size, read from its first start-of-frame segment. */
function jpeg(bytes: Uint8Array) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8)
    throw new Error("Not a JPEG image.");
  let offset = 2;
  while (offset + 9 < bytes.length) {
    const marker = bytes[offset + 1] ?? 0;
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    // SOF0-SOF15, except DHT (C4), JPG (C8), and DAC (CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
      const width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0);
      return { height, width };
    }
    offset += 2 + length;
  }
  throw new Error("The JPEG has no frame header.");
}

/** Runs each finance sync job as soon as it is queued. */
export function inlineSyncQueue(bindings: () => Bindings) {
  return {
    send: async (body: { jobId: string }) =>
      consumeJobs(
        {
          messages: [{ ack() {}, body, retry() {} }],
        } as unknown as MessageBatch<{ jobId: string }>,
        bindings(),
      ),
  } as unknown as Queue<{ jobId: string }>;
}

/** Plaid credentials for the fake below; placeholders, not secrets. */
export const plaidBindings = {
  PLAID_CLIENT_ID: "screenshot-client",
  PLAID_ENV: "sandbox",
  PLAID_SECRET: "screenshot-secret",
  // 32 bytes of 7s, base64: encrypts the fake access token at rest.
  PLAID_TOKEN_ENCRYPTION_KEY: btoa(
    String.fromCharCode(...new Uint8Array(32).fill(7)),
  ),
} as const;

export const plaidPublicToken = "public-screenshot-continuity";
const accessToken = "access-screenshot-continuity";

/**
 * Answers the API's Plaid requests with the continuity bank feed: one Item at
 * the canon's institution, holding its accounts and transactions. The API
 * reaches Plaid only through `fetch`, so this replaces `fetch` for Plaid's
 * sandbox host and refuses every other outside request.
 */
export function fakePlaid() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== "https://sandbox.plaid.com")
      throw new Error(`The screenshot API made an outside request: ${url}`);
    const body = JSON.parse(String(init?.body ?? "{}"));
    return Response.json(plaidAnswer(url.pathname, body));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

function plaidAnswer(path: string, body: { public_token?: unknown }) {
  if (path === "/item/public_token/exchange") {
    if (body.public_token !== plaidPublicToken)
      throw new Error("Unexpected Plaid public token.");
    return { access_token: accessToken, item_id: "item-screenshot-continuity" };
  }
  if (path === "/transactions/sync") return transactionsPage();
  throw new Error(`Unexpected Plaid request: ${path}`);
}

function transactionsPage(): TransactionsSyncResponse {
  const { accounts, transactions } = continuity.finance;
  return {
    accounts: accounts.map((account) => ({
      account_id: account.id,
      balances: {
        available: account.type === "credit" ? null : account.currentBalance,
        current: account.currentBalance,
        iso_currency_code: account.currencyCode,
        unofficial_currency_code: null,
      },
      mask: account.mask,
      name: account.name,
      official_name: account.officialName,
      subtype: account.subtype,
      type: account.type,
    })),
    added: transactions.map((transaction) => ({
      account_id: transaction.account,
      amount: transaction.amount,
      authorized_date: transaction.date,
      date: transaction.date,
      iso_currency_code: transaction.currencyCode,
      merchant_name: transaction.merchantName,
      name: transaction.name,
      payment_channel: "in store",
      pending: false,
      pending_transaction_id: null,
      personal_finance_category: null,
      transaction_id: transaction.id,
      unofficial_currency_code: null,
    })),
    has_more: false,
    modified: [],
    next_cursor: "cursor-screenshot-continuity",
    removed: [],
  };
}
