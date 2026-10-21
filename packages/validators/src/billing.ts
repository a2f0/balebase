import { z } from "zod";
import { route } from "./route";

/**
 * `incomplete` means the customer came back without paying: inline Checkout
 * also returns to its success URL when a redirect-based payment is canceled,
 * and the open session can still be resumed.
 */
const CheckoutOutcomeSchema = z.enum(["complete", "incomplete"]);
export type CheckoutOutcome = z.infer<typeof CheckoutOutcomeSchema>;

const BillingStatusSchema = z.object({
  billing: z.object({
    cancelAtPeriodEnd: z.boolean(),
    currentPeriodEnd: z.string().nullable(),
    status: z.string().nullable(),
  }),
  canManage: z.boolean(),
  /** Present after a Checkout return. */
  checkout: CheckoutOutcomeSchema.optional(),
  current: z.object({ formTemplates: z.number(), members: z.number() }),
  /** Null where Pro has no limit. */
  limits: z.object({
    formTemplates: z.number().nullable(),
    retentionDays: z.number().nullable(),
    users: z.number().nullable(),
  }),
  plan: z.enum(["free", "pro"]),
  pricing: z.object({
    currency: z.literal("usd"),
    proMonthlyPerSeat: z.number(),
  }),
  seats: z.number(),
});
export type BillingStatus = z.infer<typeof BillingStatusSchema>;

const InlineCheckoutSessionSchema = z.object({
  clientSecret: z.string(),
  publishableKey: z.string(),
});
export type InlineCheckoutSession = z.infer<typeof InlineCheckoutSessionSchema>;

/** A Stripe page to open. */
const StripeRedirectSchema = z.object({ url: z.string() });

export const billingRoutes = {
  status: route({
    method: "GET",
    path: "/api/billing",
    /** Set on a Checkout return, to confirm the session. */
    query: z.object({ session_id: z.string().optional() }),
    response: BillingStatusSchema,
  }),
  /** Stripe's hosted Checkout page, or an inline session to embed. */
  checkout: route({
    method: "POST",
    path: "/api/billing/checkout",
    response: z.union([StripeRedirectSchema, InlineCheckoutSessionSchema]),
  }),
  portal: route({
    method: "POST",
    path: "/api/billing/portal",
    response: StripeRedirectSchema,
  }),
};
