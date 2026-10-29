import type { Bindings } from "../types";
import { type BillingRow, findBilling } from "./billingRecords";
import type { StripeSubscription } from "./stripePayload";

export const freeFormTemplateLimit = 5;
export const freeRetentionDays = 30;
/** Days a lapsed paid organization keeps its history before Free retention. */
export const lapsedRetentionGraceDays = 30;
const unlimited = Number.MAX_SAFE_INTEGER;

export const paidStatuses = new Set(["active", "past_due", "trialing"]);
/** `paidStatuses` as a SQL list, for `stripe_status IN ${paidStatusList}`. */
export const paidStatusList = `(${[...paidStatuses]
  .map((status) => `'${status}'`)
  .join(", ")})`;

/** The Pro price and any legacy prices that still grant Pro. */
export type ProPriceEnvironment = Pick<
  Bindings,
  "STRIPE_PRO_LEGACY_PRICE_IDS" | "STRIPE_PRO_PRICE_ID"
>;
type PlanEnvironment = ProPriceEnvironment & Pick<Bindings, "DB">;

/** What the organization's plan allows; unlimited counts are a huge number. */
export async function organizationPlanLimits(
  environment: PlanEnvironment,
  organizationId: string,
) {
  return (await organizationHasPro(environment, organizationId))
    ? { formTemplates: null, invitations: unlimited, seats: unlimited }
    : { formTemplates: freeFormTemplateLimit, invitations: 0, seats: 1 };
}

/** On Free, only the first owner, or else the first member, has a seat. */
export async function organizationUserHasSeat(
  environment: PlanEnvironment,
  organizationId: string,
  userId: string,
) {
  if (await organizationHasPro(environment, organizationId)) return true;
  const row = await environment.DB.prepare(
    `SELECT userId
     FROM member
     WHERE organizationId = ?
     ORDER BY
       CASE
         WHEN (',' || replace(role, ' ', '') || ',') LIKE '%,owner,%'
           THEN 0
         ELSE 1
       END,
       createdAt ASC,
       id ASC
     LIMIT 1`,
  )
    .bind(organizationId)
    .first<{ userId: string }>();
  return row?.userId === userId;
}

export function isPaidBilling(
  record: BillingRow | null,
  environment: ProPriceEnvironment,
) {
  return Boolean(
    record?.stripe_status &&
      paidStatuses.has(record.stripe_status) &&
      record.stripe_price_id &&
      proPriceIds(environment).has(record.stripe_price_id),
  );
}

export function findProSubscriptionItem(
  subscription: StripeSubscription,
  environment: ProPriceEnvironment,
) {
  const allowedPriceIds = proPriceIds(environment);
  return subscription.items.data.find((item) =>
    allowedPriceIds.has(item.price.id),
  );
}

async function organizationHasPro(
  environment: PlanEnvironment,
  organizationId: string,
) {
  return isPaidBilling(
    await findBilling(environment.DB, organizationId),
    environment,
  );
}

function proPriceIds(environment: ProPriceEnvironment) {
  const candidates = [
    environment.STRIPE_PRO_PRICE_ID,
    ...(environment.STRIPE_PRO_LEGACY_PRICE_IDS?.split(",") ?? []),
  ];
  return new Set(
    candidates
      .map((candidate) => candidate?.trim() ?? "")
      .filter(
        (candidate) =>
          candidate.startsWith("price_") && candidate.length <= 255,
      ),
  );
}
