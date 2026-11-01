import { StripeApiError } from "./stripe";

export interface StripeCheckoutSession {
  client_reference_id: string | null;
  client_secret?: string | null;
  customer: StripeExpandable | null;
  expires_at?: number;
  id: string;
  metadata?: {
    checkout_claim_id?: string;
    organization_id?: string;
    [key: string]: string | undefined;
  };
  status: string | null;
  subscription: StripeExpandable | StripeSubscription | null;
  url?: string | null;
}

interface StripeSubscriptionItem {
  current_period_end?: number;
  id: string;
  price: { id: string };
  quantity?: number;
}

interface StripeSeatItemResponse {
  id: string;
  quantity: number;
}

export interface StripeSubscription {
  cancel_at?: number | null;
  cancel_at_period_end?: boolean;
  /** When a canceled subscription ended, in Unix seconds. */
  canceled_at?: number;
  /** The comment given with a cancellation, such as the deleting request's
   * marker. */
  cancellation_details?: { comment: string | null };
  current_period_end?: number;
  customer: StripeExpandable;
  id: string;
  items: { data: StripeSubscriptionItem[] };
  metadata?: {
    checkout_claim_id?: string;
    organization_id?: string;
    [key: string]: string | undefined;
  };
  status: string;
}

export interface StripeEvent {
  created: number;
  data: { object: unknown };
  id: string;
  type: string;
}

interface StripePayloadRecord extends Record<string, unknown> {
  cancel_at?: unknown;
  cancel_at_period_end?: unknown;
  canceled_at?: unknown;
  cancellation_details?: unknown;
  client_reference_id?: unknown;
  client_secret?: unknown;
  comment?: unknown;
  current_period_end?: unknown;
  customer?: unknown;
  data?: unknown;
  expires_at?: unknown;
  id?: unknown;
  items?: unknown;
  metadata?: unknown;
  parent?: unknown;
  price?: unknown;
  quantity?: unknown;
  status?: unknown;
  subscription?: unknown;
  subscription_details?: unknown;
  url?: unknown;
}

export type StripeExpandable = string | { id: string };

export function validEvent(value: StripeEvent) {
  return (
    typeof value?.id === "string" &&
    value.id.startsWith("evt_") &&
    typeof value.type === "string" &&
    Number.isSafeInteger(value.created) &&
    typeof value.data === "object" &&
    value.data !== null
  );
}

export function stripeInvoiceSubscriptionId(value: unknown) {
  const invoice = stripeRecord(value, "Invoice");
  if (invoice.subscription !== undefined && invoice.subscription !== null) {
    return expandableId(stripeExpandable(invoice.subscription, "sub_"));
  }
  if (invoice.parent === undefined || invoice.parent === null) return null;
  const parent = stripeRecord(invoice.parent, "Invoice parent");
  if (
    parent.subscription_details === undefined ||
    parent.subscription_details === null
  ) {
    return null;
  }
  const details = stripeRecord(
    parent.subscription_details,
    "Invoice subscription details",
  );
  return details.subscription === undefined || details.subscription === null
    ? null
    : expandableId(stripeExpandable(details.subscription, "sub_"));
}

export function optionalExpandableId(value: StripeExpandable | null) {
  return value ? expandableId(value) : null;
}

export function expandableId(value: StripeExpandable) {
  return typeof value === "string" ? value : value.id;
}

export function parseStripeCheckoutSession(
  value: unknown,
): StripeCheckoutSession {
  const record = stripeRecord(value, "Checkout session");
  const session: StripeCheckoutSession = {
    client_reference_id: stripeNullableString(
      record.client_reference_id,
      "Checkout client reference",
    ),
    client_secret: stripeNullableString(
      record.client_secret,
      "Checkout client secret",
    ),
    customer: stripeOptionalExpandable(record.customer, "cus_"),
    id: stripeString(record.id, "Checkout session ID", "cs_"),
    status: stripeNullableString(record.status, "Checkout status"),
    subscription: stripeOptionalSubscription(record.subscription),
  };
  const expiresAt = stripeOptionalInteger(
    record.expires_at,
    "Checkout expiration",
  );
  if (expiresAt !== undefined) session.expires_at = expiresAt;
  const metadata = stripeOptionalMetadata(record.metadata);
  if (metadata) session.metadata = metadata;
  const url = stripeOptionalNullableString(record.url, "Checkout URL");
  if (url !== undefined) session.url = url;
  return session;
}

export function parseStripeSubscription(value: unknown): StripeSubscription {
  const record = stripeRecord(value, "Subscription");
  const items = stripeRecord(record.items, "Subscription items").data;
  if (!Array.isArray(items)) {
    throw malformedStripeResponse("Subscription items");
  }
  const subscription: StripeSubscription = {
    customer: stripeExpandable(record.customer, "cus_"),
    id: stripeString(record.id, "Subscription ID", "sub_"),
    items: { data: items.map((item) => parseStripeSubscriptionItem(item)) },
    status: stripeString(record.status, "Subscription status"),
  };
  if (record.cancel_at === null) {
    subscription.cancel_at = null;
  } else {
    const cancelAt = stripeOptionalInteger(
      record.cancel_at,
      "Subscription cancel",
    );
    if (cancelAt !== undefined) subscription.cancel_at = cancelAt;
  }
  const cancelAtPeriodEnd = stripeOptionalBoolean(
    record.cancel_at_period_end,
    "Subscription cancellation",
  );
  if (cancelAtPeriodEnd !== undefined) {
    subscription.cancel_at_period_end = cancelAtPeriodEnd;
  }
  const periodEnd = stripeOptionalInteger(
    record.current_period_end,
    "Subscription period end",
  );
  if (periodEnd !== undefined) subscription.current_period_end = periodEnd;
  const canceledAt =
    record.canceled_at === null
      ? undefined
      : stripeOptionalInteger(record.canceled_at, "Subscription canceled at");
  if (canceledAt !== undefined) subscription.canceled_at = canceledAt;
  const cancellationComment = stripeCancellationComment(
    record.cancellation_details,
  );
  if (cancellationComment !== undefined) {
    subscription.cancellation_details = { comment: cancellationComment };
  }
  const metadata = stripeOptionalMetadata(record.metadata);
  if (metadata) subscription.metadata = metadata;
  return subscription;
}

function stripeCancellationComment(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const details = stripeRecord(value, "Subscription cancellation details");
  if (details.comment === "") return null;
  return stripeOptionalNullableString(
    details.comment,
    "Subscription cancellation comment",
  );
}

function parseStripeSubscriptionItem(value: unknown): StripeSubscriptionItem {
  const record = stripeRecord(value, "Subscription item");
  const price = stripeRecord(record.price, "Subscription item price");
  const item: StripeSubscriptionItem = {
    id: stripeString(record.id, "Subscription item ID", "si_"),
    price: { id: stripeString(price.id, "Stripe price ID", "price_") },
  };
  const periodEnd = stripeOptionalInteger(
    record.current_period_end,
    "Subscription item period end",
  );
  if (periodEnd !== undefined) item.current_period_end = periodEnd;
  const quantity = stripeOptionalInteger(
    record.quantity,
    "Subscription item quantity",
  );
  if (quantity !== undefined && quantity < 1) {
    throw malformedStripeResponse("Subscription item quantity");
  }
  if (quantity !== undefined) item.quantity = quantity;
  return item;
}

export function parseStripeSeatItemResponse(
  value: unknown,
): StripeSeatItemResponse {
  const record = stripeRecord(value, "Subscription item");
  const quantity = stripeOptionalInteger(
    record.quantity,
    "Subscription item quantity",
  );
  if (quantity === undefined || quantity < 1) {
    throw malformedStripeResponse("Subscription item quantity");
  }
  return {
    id: stripeString(record.id, "Subscription item ID", "si_"),
    quantity,
  };
}

export function parseStripePortalSession(value: unknown) {
  const record = stripeRecord(value, "Billing Portal session");
  return {
    id: stripeString(record.id, "Billing Portal session ID", "bps_"),
    url: stripeString(record.url, "Billing Portal URL", "https://"),
  };
}

function stripeOptionalSubscription(
  value: unknown,
): StripeExpandable | StripeSubscription | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "object" && value !== null && "items" in value) {
    return parseStripeSubscription(value);
  }
  return stripeExpandable(value, "sub_");
}

function stripeOptionalExpandable(
  value: unknown,
  prefix: string,
): StripeExpandable | null {
  if (value === undefined || value === null) return null;
  return stripeExpandable(value, prefix);
}

function stripeExpandable(value: unknown, prefix: string): StripeExpandable {
  if (typeof value === "string") {
    return stripeString(value, "Stripe object ID", prefix);
  }
  const record = stripeRecord(value, "Expandable Stripe object");
  return { id: stripeString(record.id, "Stripe object ID", prefix) };
}

export function stripeObjectId(value: unknown, prefix: string) {
  return stripeString(
    stripeRecord(value, "Stripe event object").id,
    "Stripe event object ID",
    prefix,
  );
}

function stripeRecord(value: unknown, label: string): StripePayloadRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw malformedStripeResponse(label);
  }
  return value as StripePayloadRecord;
}

function stripeString(value: unknown, label: string, prefix?: string) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (prefix !== undefined && !value.startsWith(prefix))
  ) {
    throw malformedStripeResponse(label);
  }
  return value;
}

function stripeNullableString(value: unknown, label: string) {
  if (value === undefined || value === null) return null;
  return stripeString(value, label);
}

function stripeOptionalNullableString(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return stripeString(value, label);
}

function stripeOptionalInteger(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw malformedStripeResponse(label);
  return value as number;
}

function stripeOptionalBoolean(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw malformedStripeResponse(label);
  return value;
}

function stripeOptionalMetadata(value: unknown) {
  if (value === undefined) return undefined;
  const record = stripeRecord(value, "Stripe metadata");
  const metadata: Record<string, string> = {};
  for (const [key, field] of Object.entries(record)) {
    metadata[key] = stripeString(field, "Stripe metadata value");
  }
  return metadata;
}

function malformedStripeResponse(label: string) {
  return new StripeApiError(`Stripe returned a malformed ${label}.`, 502);
}
