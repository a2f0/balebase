import {
  type FinanceInstitutionHealth,
  financeRoutes,
  type InstitutionProductHealth,
} from "@balebase/validators/finance";
import { isRecord } from "../shared/jsonInput";
import { respond } from "../shared/respond";
import type { FinanceContext } from "./financeContext";
import type { PlaidRequest } from "./plaid";

/** How long one institution's answer is reused, so repeated checks by many
 * users of one bank cost Plaid one request. */
export const institutionHealthTtlMs = 5 * 60_000;
const maxCachedInstitutions = 500;

type InstitutionHealth = Omit<
  FinanceInstitutionHealth,
  "institutionId" | "institutionName"
>;

/** Shared by one router (one Worker isolate); keyed by Plaid environment. */
export type InstitutionHealthCache = Map<
  string,
  { expiresAt: number; health: Promise<InstitutionHealth> }
>;

/**
 * Plaid's live health for the bank behind one of the organization's
 * connections. It calls the read-only `/institutions/get_by_id` with the
 * application's Plaid credentials and the stored institution ID: no access
 * token is decrypted and the customer supplies nothing but the connection.
 */
export async function institutionHealth(
  context: FinanceContext,
  requestPlaid: PlaidRequest,
  cache: InstitutionHealthCache,
) {
  const connection = await context.env.DB.prepare(
    `SELECT institution_id, institution_name FROM plaid_items
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(context.req.param("id") ?? "", context.get("organizationId"))
    .first<{
      institution_id: string | null;
      institution_name: string | null;
    }>();
  if (!connection) {
    return context.json({ error: "Connection not found." }, 404);
  }
  const institutionId = connection.institution_id;
  const health = institutionId
    ? await cachedHealth(context, requestPlaid, cache, institutionId)
    : { checkedAt: new Date().toISOString(), logins: null, transactions: null };
  return respond(context, financeRoutes.institutionHealth, {
    ...health,
    institutionId,
    institutionName: connection.institution_name,
  });
}

function cachedHealth(
  context: FinanceContext,
  requestPlaid: PlaidRequest,
  cache: InstitutionHealthCache,
  institutionId: string,
) {
  const key = `${context.env.PLAID_ENV ?? "sandbox"}:${institutionId}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.health;
  cache.delete(key);
  const health = fetchHealth(context, requestPlaid, institutionId);
  // A failed lookup is not kept, so the next check asks Plaid again.
  health.catch(() => {
    if (cache.get(key)?.health === health) cache.delete(key);
  });
  cache.set(key, { expiresAt: Date.now() + institutionHealthTtlMs, health });
  // Maps keep insertion order, so the first key is the oldest entry.
  if (cache.size > maxCachedInstitutions) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return health;
}

async function fetchHealth(
  context: FinanceContext,
  requestPlaid: PlaidRequest,
  institutionId: string,
): Promise<InstitutionHealth> {
  const checkedAt = new Date().toISOString();
  const result = await requestPlaid<unknown>(
    context.env,
    "/institutions/get_by_id",
    {
      country_codes: ["US"],
      institution_id: institutionId,
      options: { include_status: true },
    },
  );
  const institution = isRecord<"institution">(result)
    ? result.institution
    : undefined;
  const status: Partial<
    Record<"item_logins" | "transactions_updates", unknown>
  > =
    isRecord<"status">(institution) &&
    isRecord<"item_logins" | "transactions_updates">(institution.status)
      ? institution.status
      : {};
  const transactions = productHealth(status.transactions_updates);
  return {
    checkedAt,
    logins: productHealth(status.item_logins),
    transactions: transactions && {
      ...transactions,
      refreshInterval: text(
        breakdown(status.transactions_updates).refresh_interval,
      ),
    },
  };
}

/** Missing sections and fields stay null: unknown, never assumed healthy. */
function productHealth(value: unknown): InstitutionProductHealth | null {
  if (!isRecord<"last_status_change" | "status">(value)) return null;
  const rates = breakdown(value);
  return {
    institutionErrorRate: percent(rates.error_institution),
    lastStatusChange: text(value.last_status_change),
    plaidErrorRate: percent(rates.error_plaid),
    status: text(value.status),
    successRate: percent(rates.success),
  };
}

type BreakdownKey =
  | "error_institution"
  | "error_plaid"
  | "refresh_interval"
  | "success";

function breakdown(value: unknown): Partial<Record<BreakdownKey, unknown>> {
  return isRecord<"breakdown">(value) && isRecord<BreakdownKey>(value.breakdown)
    ? value.breakdown
    : {};
}

/** Plaid reports fractions of recent requests; show percentages. */
function percent(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 1000) / 10
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : null;
}
