import type { Database } from "bun:sqlite";
import { createAuth } from "../auth/auth";
import { testBindings } from "./bindings";
import { toD1 } from "./d1";
import { createTestDatabase } from "./database";

export const baseURL = "https://api.test";
export const origin = "https://app.test";
export const email = "person@example.com";
export const originalPassword = "correct horse battery staple";

export function financeGroupFor(database: Database, organizationId: string) {
  return database
    .query(
      `SELECT "team"."name", "team"."memberCount",
              access."capability"
       FROM "team"
       JOIN organization_group_capability AS access
         ON access.team_id = "team"."id"
       WHERE "team"."organizationId" = ? AND access.capability = 'finance'`,
    )
    .get(organizationId);
}

export function executionContext(pending: Promise<unknown>[]) {
  return {
    passThroughOnException: () => undefined,
    props: {},
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } as unknown as ExecutionContext;
}

export async function createFixture() {
  const database = createTestDatabase();
  const messages: EmailMessageBuilder[] = [];
  const pending: Promise<unknown>[] = [];
  const bindings = testBindings({
    BETTER_AUTH_URL: baseURL,
    CORS_ORIGIN: origin,
    DB: toD1(database),
    EMAIL: {
      send: async (message: EmailMessageBuilder) => {
        messages.push(message);
        return { messageId: "test-message" };
      },
    } as unknown as SendEmail,
    STRIPE_PRO_PRICE_ID: "price_pro_test",
  });
  const auth = createAuth(bindings, (promise) => pending.push(promise));
  return { auth, bindings, database, messages, pending };
}

export function post(
  auth: ReturnType<typeof createAuth>,
  path: string,
  body: Record<string, unknown>,
  cookie?: string | null,
  requestOrigin = origin,
) {
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        cookie: cookie ?? "",
        origin: requestOrigin,
      },
      method: "POST",
    }),
  );
}

export function get(
  auth: ReturnType<typeof createAuth>,
  path: string,
  cookie: string | null,
) {
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, {
      headers: { cookie: cookie ?? "", origin },
    }),
  );
}

export class CookieJar {
  readonly #cookies = new Map<string, string>();

  absorb(response: Response) {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (!value || /max-age=0/i.test(header)) {
        this.#cookies.delete(name);
      } else {
        this.#cookies.set(name, value);
      }
    }
  }

  header() {
    return [...this.#cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}
