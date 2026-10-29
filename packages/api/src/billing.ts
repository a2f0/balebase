import {
  type BillingStatus,
  billingRoutes,
  type CheckoutOutcome,
} from "@balebase/validators/billing";
import { type Context, Hono } from "hono";
import type { ApiEnv } from "./auth/authMiddleware";
import {
  activePendingCheckout,
  checkoutDeletionInProgress,
  checkoutParameters,
  checkoutPublishableKey,
  claimCheckout,
  completeCheckoutClaim,
  expireCheckoutSession,
  openedCheckout,
  releaseCheckoutClaim,
  stalePendingCheckoutId,
  storePendingCheckout,
} from "./billingCheckout";
import {
  confirmCheckoutSession,
  reconcilePendingCheckoutEntitlement,
} from "./billingCheckoutSync";
import {
  freeFormTemplateLimit,
  freeRetentionDays,
  isPaidBilling,
} from "./billingEntitlements";
import { countMembers, findBilling } from "./billingRecords";
import {
  canManage,
  canManageOrganization,
  requireManager,
} from "./organizations/organizationMembers";
import { respond } from "./shared/respond";
import {
  StripeApiError,
  StripeConfigurationError,
  stripeGet,
  stripePost,
} from "./stripe";
import {
  parseStripeCheckoutSession,
  parseStripePortalSession,
  type StripeCheckoutSession,
} from "./stripePayload";
import type { Bindings } from "./types";

const billing = new Hono<ApiEnv>();

const billingManagerRequired = "Organization billing access is required.";
const requireBillingManager = requireManager(billingManagerRequired);

billing.get("/", async (context) => {
  const organizationId = context.get("organizationId");
  const sessionId = context.req.query("session_id");
  if (sessionId) {
    if (!canManage(context)) {
      return context.json({ error: billingManagerRequired }, 403);
    }
    if (!sessionId.startsWith("cs_") || sessionId.length > 255) {
      return context.json({ error: "Checkout session is invalid." }, 400);
    }
  }
  let checkout: CheckoutOutcome | undefined;
  if (sessionId) {
    try {
      checkout = await confirmCheckoutSession(
        context.env,
        organizationId,
        sessionId,
      );
    } catch (cause) {
      return billingError(context, cause);
    }
  }
  const summary = await billingSummary(
    context.env,
    organizationId,
    context.get("organizationRole"),
  );
  return respond(
    context,
    billingRoutes.status,
    checkout ? { ...summary, checkout } : summary,
  );
});

billing.post("/checkout", requireBillingManager, async (context) => {
  const organizationId = context.get("organizationId");
  const priceId = context.env.STRIPE_PRO_PRICE_ID;
  if (!priceId) return billingUnavailableResponse(context);
  const prepared = await prepareCheckoutState(context, organizationId);
  if (prepared instanceof Response) return prepared;
  const state = prepared;
  const checkoutClaim = await claimCheckout(
    context.env.DB,
    organizationId,
    priceId,
    Math.max(1, state.memberCount),
    state.nowSeconds,
  );
  const record = checkoutClaim.record;
  if (isPaidBilling(record, context.env)) return alreadyProResponse(context);
  if (checkoutDeletionInProgress(record, state.nowSeconds))
    return checkoutDisabledResponse(context);
  const claimedPending = activePendingCheckout(record, state.nowSeconds);
  if (claimedPending) return pendingCheckoutResponse(context, claimedPending);
  if (!checkoutClaim.owned || !completeCheckoutClaim(record, checkoutClaim.id))
    return checkoutInProgressResponse(context);
  const publishableKey = checkoutPublishableKey(context.env);
  const parameters = checkoutParameters(
    context.env.CORS_ORIGIN,
    organizationId,
    record.checkout_claim_price_id,
    record,
    publishableKey ? context.get("authSession").user.email : null,
  );
  try {
    const checkout = parseStripeCheckoutSession(
      await stripePost(
        context.env,
        "/v1/checkout/sessions",
        parameters,
        `checkout:${organizationId}:${checkoutClaim.id}`,
      ),
    );
    const opened = openedCheckout(checkout, publishableKey);
    if (!opened) {
      throw new StripeApiError(
        publishableKey
          ? "Stripe did not return a checkout client secret."
          : "Stripe did not return a checkout URL.",
        502,
      );
    }
    const stored = await storePendingCheckout(
      context.env.DB,
      organizationId,
      checkoutClaim.id,
      checkout,
    );
    if (!stored) {
      await expireCheckoutSession(context.env, checkout.id);
      return context.json(
        { error: "Checkout could not be reserved. Please try again." },
        409,
      );
    }
    return respond(context, billingRoutes.checkout, opened);
  } catch (cause) {
    return checkoutCreationError(
      context,
      cause,
      organizationId,
      checkoutClaim.id,
    );
  }
});

billing.post("/portal", requireBillingManager, async (context) => {
  const organizationId = context.get("organizationId");
  const record = await findBilling(context.env.DB, organizationId);
  if (!record?.stripe_customer_id) {
    return context.json(
      { error: "This organization does not have a billing account yet." },
      409,
    );
  }
  const parameters = new URLSearchParams({
    customer: record.stripe_customer_id,
    return_url: `${context.env.CORS_ORIGIN}/organization/billing`,
  });
  if (context.env.STRIPE_PORTAL_CONFIGURATION_ID) {
    parameters.set("configuration", context.env.STRIPE_PORTAL_CONFIGURATION_ID);
  }
  try {
    const portal = parseStripePortalSession(
      await stripePost(context.env, "/v1/billing_portal/sessions", parameters),
    );
    if (!portal.url) throw new Error("Stripe did not return a portal URL.");
    return respond(context, billingRoutes.portal, { url: portal.url });
  } catch (cause) {
    return billingError(context, cause);
  }
});

async function billingSummary(
  environment: Pick<
    Bindings,
    "DB" | "STRIPE_PRO_LEGACY_PRICE_IDS" | "STRIPE_PRO_PRICE_ID"
  >,
  organizationId: string,
  organizationRole: string,
): Promise<BillingStatus> {
  const [record, memberCount, formTemplateCount] = await Promise.all([
    findBilling(environment.DB, organizationId),
    countMembers(environment.DB, organizationId),
    countOrganizationTemplates(environment.DB, organizationId),
  ]);
  const pro = isPaidBilling(record, environment);
  return {
    billing: {
      cancelAtPeriodEnd: Boolean(record?.cancel_at_period_end),
      currentPeriodEnd: record?.current_period_end ?? null,
      status: record?.stripe_status ?? null,
    },
    canManage: canManageOrganization(organizationRole),
    current: {
      formTemplates: formTemplateCount,
      members: memberCount,
    },
    limits: pro
      ? { formTemplates: null, retentionDays: null, users: null }
      : {
          formTemplates: freeFormTemplateLimit,
          retentionDays: freeRetentionDays,
          users: 1,
        },
    plan: pro ? "pro" : "free",
    pricing: { currency: "usd", proMonthlyPerSeat: 1_000 },
    seats: pro ? Math.max(record?.seat_quantity ?? 1, memberCount) : 1,
  };
}

async function countOrganizationTemplates(
  database: D1Database,
  organizationId: string,
) {
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM audit_template_families
       WHERE scope = 'organization' AND organization_id = ?`,
    )
    .bind(organizationId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function prepareCheckoutState(
  context: Context<ApiEnv>,
  organizationId: string,
) {
  let state = await checkoutState(context.env.DB, organizationId);
  const existingResponse = await checkoutStateResponse(context, state);
  if (existingResponse) return existingResponse;
  const staleSessionId = stalePendingCheckoutId(
    state.billingRecord,
    state.nowSeconds,
  );
  if (!staleSessionId) return state;
  try {
    await reconcilePendingCheckoutEntitlement(
      context.env,
      organizationId,
      staleSessionId,
      state.nowSeconds,
    );
  } catch (cause) {
    return billingError(context, cause);
  }
  state = await checkoutState(context.env.DB, organizationId);
  return (await checkoutStateResponse(context, state)) ?? state;
}

async function checkoutStateResponse(
  context: Context<ApiEnv>,
  state: Awaited<ReturnType<typeof checkoutState>>,
) {
  if (checkoutDeletionInProgress(state.billingRecord, state.nowSeconds)) {
    return checkoutDisabledResponse(context);
  }
  if (isPaidBilling(state.billingRecord, context.env)) {
    return alreadyProResponse(context);
  }
  const pending = activePendingCheckout(state.billingRecord, state.nowSeconds);
  return pending ? pendingCheckoutResponse(context, pending) : null;
}

/**
 * Resumes the organization's open Checkout. A hosted session reuses its stored
 * URL. An inline session has no URL, and its client secret is never stored, so
 * it is read back from Stripe while the session is still open.
 */
async function pendingCheckoutResponse(
  context: Context<ApiEnv>,
  pending: { id: string; url: string | null },
) {
  if (pending.url)
    return respond(context, billingRoutes.checkout, { url: pending.url });
  const publishableKey = checkoutPublishableKey(context.env);
  if (!publishableKey) return checkoutInProgressResponse(context);
  let session: StripeCheckoutSession;
  try {
    session = parseStripeCheckoutSession(
      await stripeGet(
        context.env,
        `/v1/checkout/sessions/${encodeURIComponent(pending.id)}`,
      ),
    );
  } catch (cause) {
    return billingError(context, cause);
  }
  if (
    session.status !== "open" ||
    !session.client_secret ||
    session.client_reference_id !== context.get("organizationId")
  ) {
    return checkoutInProgressResponse(context);
  }
  return respond(context, billingRoutes.checkout, {
    clientSecret: session.client_secret,
    publishableKey,
  });
}

async function checkoutState(database: D1Database, organizationId: string) {
  const [billingRecord, memberCount] = await Promise.all([
    findBilling(database, organizationId),
    countMembers(database, organizationId),
  ]);
  return {
    billingRecord,
    memberCount,
    nowSeconds: Math.floor(Date.now() / 1_000),
  };
}

function billingError(context: Context<ApiEnv>, cause: unknown) {
  if (cause instanceof StripeConfigurationError) {
    return context.json({ error: cause.message }, 503);
  }
  if (cause instanceof StripeApiError) {
    console.error("Stripe billing request failed", cause.status, cause.message);
    const status = cause.status === 409 ? 409 : 502;
    return context.json({ error: cause.message }, status);
  }
  throw cause;
}

async function checkoutCreationError(
  context: Context<ApiEnv>,
  cause: unknown,
  organizationId: string,
  claimId: string,
) {
  if (
    cause instanceof StripeConfigurationError ||
    (cause instanceof StripeApiError && cause.status < 500)
  ) {
    await releaseCheckoutClaim(context.env.DB, organizationId, claimId);
  }
  return billingError(context, cause);
}

function checkoutDisabledResponse(context: Context<ApiEnv>) {
  return context.json(
    {
      error:
        "Checkout is unavailable while this organization is being deleted.",
    },
    409,
  );
}

function billingUnavailableResponse(context: Context<ApiEnv>) {
  return context.json({ error: "Stripe billing is not configured." }, 503);
}

function checkoutInProgressResponse(context: Context<ApiEnv>) {
  return context.json(
    { error: "Checkout is already being prepared. Try again shortly." },
    409,
  );
}

function alreadyProResponse(context: Context<ApiEnv>) {
  return context.json(
    { error: "This organization already has a Pro subscription." },
    409,
  );
}

export { billing };
