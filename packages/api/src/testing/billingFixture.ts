import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { AuthVariables } from "../auth/apiEnv";
import { billing } from "../billing/billing";
import { handleStripeWebhook } from "../billing/billingWebhook";
import type { Bindings } from "../types";
import { testBindings } from "./bindings";
import { toD1 } from "./d1";
import { createTestDatabase } from "./database";
import { insertBilling, seedAccount } from "./seed";
import { testApp } from "./session";

export const organizationId = "org_user-1";
export const proPriceId = "price_pro_test";

export function createFixture(organizationRole = "owner") {
  const database = createTestDatabase();
  for (const id of ["user-1", "user-2", "user-3"])
    seedAccount(database, { createdAt: new Date().toISOString(), id });
  const bindings = testBindings({
    AUTH_EMAIL_FROM: "security@auth.balebase.test",
    BETTER_AUTH_URL: "https://api.balebase.test",
    CORS_ORIGIN: "https://app.balebase.test",
    DB: toD1(database),
    INBOUND_EMAIL_DOMAIN: "inbox.balebase.test",
    STRIPE_PRO_LEGACY_PRICE_IDS: "",
    STRIPE_PRO_PRICE_ID: proPriceId,
    STRIPE_SECRET_KEY: "sk_live_test",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
  });
  const app = testApp(
    { "/": billing },
    {
      email: "user-1@example.com",
      organizationId,
      organizationRole,
      userId: "user-1",
    },
  );
  const webhook = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  webhook.post("/", handleStripeWebhook);
  return {
    app,
    bindings,
    database,
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, bindings),
    webhook,
  };
}

/**
 * A Stripe subscription cancel route that returns `subscription` with the
 * comment the request sent, as Stripe does.
 */
export function echoCancellation(subscription: Record<string, unknown>) {
  return (call: { url: string }) =>
    Response.json({
      ...subscription,
      cancellation_details: {
        comment: new URL(call.url).searchParams.get(
          "cancellation_details[comment]",
        ),
      },
    });
}

export function subscriptionEvent(
  id: string,
  created: number,
  status: string,
  quantity: number,
  subscriptionId = "sub_test",
  priceId = proPriceId,
) {
  return {
    created,
    data: {
      object: {
        cancel_at: null,
        cancel_at_period_end: false,
        customer: "cus_test",
        id: subscriptionId,
        items: {
          data: [
            {
              current_period_end: 1_800_000_000,
              id:
                subscriptionId === "sub_test"
                  ? "si_test"
                  : `si_${subscriptionId}`,
              price: { id: priceId },
              quantity,
            },
          ],
        },
        metadata: { organization_id: organizationId },
        status,
      },
    },
    id,
    type: `customer.subscription.${status === "canceled" ? "deleted" : "updated"}`,
  };
}

export async function sendWebhook(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  event: {
    created: number;
    data: { object: unknown };
    id: string;
    type: string;
  },
) {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = await webhookSignature(
    fixture.bindings.STRIPE_WEBHOOK_SECRET ?? "",
    timestamp,
    payload,
  );
  return fixture.webhook.request(
    "/",
    {
      body: payload,
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      method: "POST",
    },
    fixture.bindings,
  );
}

export async function webhookSignature(
  secret: string,
  timestamp: number,
  payload: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${payload}`),
    ),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function insertAudit(
  database: Database,
  id: string,
  target: string,
  createdAt: string,
) {
  database
    .query(
      `INSERT INTO audits
       (id, organization_id, template_name, definition, responses, status,
        started_by, created_at, updated_at)
       VALUES (?, ?, 'Example form', '{"version":1,"sections":[]}', '{}',
               'completed', 'user-1', ?, ?)`,
    )
    .run(id, target, createdAt, createdAt);
}

export function reserveCheckout(database: Database, sessionId: string) {
  database
    .query(
      `UPDATE organization_billing
       SET pending_checkout_session_id = ?,
           pending_checkout_url = 'https://checkout.stripe.test/pending',
           pending_checkout_expires_at = 2000000000
       WHERE organization_id = ?`,
    )
    .run(sessionId, organizationId);
}

export function insertStalePendingCheckout(
  database: Database,
  sessionId: string,
) {
  insertBilling(database, organizationId, {
    pending_checkout_expires_at: 1,
    pending_checkout_session_id: sessionId,
    pending_checkout_url: "https://checkout.stripe.test/stale",
  });
}
