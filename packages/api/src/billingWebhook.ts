import type { Context } from "hono";
import type { ApiEnv } from "./authMiddleware";
import {
  refreshSubscription,
  type SubscriptionEnvironment,
} from "./billingSubscriptions";
import { readBoundedRequest } from "./shared/storage";
import { StripeConfigurationError, verifyStripeWebhook } from "./stripe";
import {
  optionalExpandableId,
  parseStripeCheckoutSession,
  type StripeEvent,
  stripeInvoiceSubscriptionId,
  stripeObjectId,
  validEvent,
} from "./stripePayload";
import type { Bindings } from "./types";

const maxStripeWebhookBytes = 256 * 1024;
const webhookClaimTimeoutMilliseconds = 5 * 60 * 1000;
const stripeWebhookReceiptCleanupLimit = 500;
const stripeWebhookReceiptRetentionDays = 31;

export async function handleStripeWebhook(context: Context<ApiEnv>) {
  const payload = await readBoundedRequest(
    context.req.raw,
    maxStripeWebhookBytes,
  );
  if (payload === null) {
    return context.json({ error: "Webhook payload is too large." }, 413);
  }
  let verified: boolean;
  try {
    verified = await verifyStripeWebhook(
      payload,
      context.req.header("stripe-signature"),
      context.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (cause) {
    if (cause instanceof StripeConfigurationError) {
      console.error(cause.message);
      return context.json(
        { error: "Webhook verification is unavailable." },
        503,
      );
    }
    throw cause;
  }
  if (!verified) {
    return context.json({ error: "Webhook signature is invalid." }, 400);
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(new TextDecoder().decode(payload)) as StripeEvent;
  } catch {
    return context.json({ error: "Webhook payload is invalid." }, 400);
  }
  if (!validEvent(event)) {
    return context.json({ error: "Webhook event is invalid." }, 400);
  }
  const claimed = await claimWebhookEvent(context.env.DB, event);
  if (claimed === "processed") return context.json({ received: true });
  if (claimed === "processing") {
    return context.json(
      { error: "Webhook event is already being processed." },
      503,
    );
  }
  try {
    await processStripeEvent(context.env, event);
    await context.env.DB.prepare(
      `UPDATE stripe_webhook_events SET processed_at = ? WHERE id = ?`,
    )
      .bind(new Date().toISOString(), event.id)
      .run();
  } catch (cause) {
    await context.env.DB.prepare(
      `DELETE FROM stripe_webhook_events WHERE id = ? AND processed_at IS NULL`,
    )
      .bind(event.id)
      .run();
    throw cause;
  }
  return context.json({ received: true });
}

export async function purgeStripeWebhookReceipts(
  environment: Pick<Bindings, "DB">,
  retainedAfter = new Date(
    Date.now() - stripeWebhookReceiptRetentionDays * 24 * 60 * 60 * 1_000,
  ).toISOString(),
) {
  const deleted = await environment.DB.prepare(
    `DELETE FROM stripe_webhook_events
     WHERE id IN (
       SELECT id FROM stripe_webhook_events
       WHERE datetime(COALESCE(processed_at, received_at)) < datetime(?)
       ORDER BY datetime(COALESCE(processed_at, received_at)) ASC, id ASC
       LIMIT ?
     )
     RETURNING id`,
  )
    .bind(retainedAfter, stripeWebhookReceiptCleanupLimit)
    .all<{ id: string }>();
  return deleted.results.length;
}

async function processStripeEvent(
  environment: SubscriptionEnvironment,
  event: StripeEvent,
) {
  if (event.type === "checkout.session.completed") {
    const session = parseStripeCheckoutSession(event.data.object);
    const organizationId =
      session.client_reference_id ?? session.metadata?.organization_id;
    if (!organizationId) return;
    const subscriptionId = optionalExpandableId(session.subscription);
    if (subscriptionId && session.id) {
      await refreshSubscription(
        environment,
        subscriptionId,
        event.created,
        organizationId,
        session.id,
        session.metadata?.checkout_claim_id,
      );
    }
    return;
  }
  if (event.type.startsWith("customer.subscription.")) {
    const subscriptionId = stripeObjectId(event.data.object, "sub_");
    await refreshSubscription(environment, subscriptionId, event.created);
    return;
  }
  if (
    event.type === "invoice.paid" ||
    event.type === "invoice.payment_failed"
  ) {
    const id = stripeInvoiceSubscriptionId(event.data.object);
    if (id) await refreshSubscription(environment, id, event.created);
  }
}

async function claimWebhookEvent(database: D1Database, event: StripeEvent) {
  const now = new Date().toISOString();
  const inserted = await database
    .prepare(
      `INSERT OR IGNORE INTO stripe_webhook_events
       (id, event_type, stripe_created, received_at, processed_at)
       VALUES (?, ?, ?, ?, NULL)`,
    )
    .bind(event.id, event.type, event.created, now)
    .run();
  if (Number(inserted.meta.changes) > 0) return "claimed" as const;
  const existing = await database
    .prepare(`SELECT processed_at FROM stripe_webhook_events WHERE id = ?`)
    .bind(event.id)
    .first<{ processed_at: string | null }>();
  if (existing?.processed_at) return "processed" as const;
  const staleBefore = new Date(
    Date.now() - webhookClaimTimeoutMilliseconds,
  ).toISOString();
  const reclaimed = await database
    .prepare(
      `UPDATE stripe_webhook_events SET received_at = ?
       WHERE id = ? AND processed_at IS NULL
         AND datetime(received_at) <= datetime(?)`,
    )
    .bind(now, event.id, staleBefore)
    .run();
  if (Number(reclaimed.meta.changes) > 0) return "claimed" as const;
  const completed = await database
    .prepare(`SELECT processed_at FROM stripe_webhook_events WHERE id = ?`)
    .bind(event.id)
    .first<{ processed_at: string | null }>();
  return completed?.processed_at
    ? ("processed" as const)
    : ("processing" as const);
}
