import { productName } from "@balebase/ui/brand";
import { financeRoutes } from "@balebase/validators/finance";
import { readBody, respond } from "../shared/respond";
import type { Bindings } from "../types";
import type { FinanceContext } from "./financeContext";
import { PlaidApiError, type PlaidRequest } from "./plaid";
import { decryptToken } from "./plaidCrypto";

interface LinkTokenResponse {
  expiration: string;
  link_token: string;
  request_id?: string;
}

/** Starts Plaid Link for a new Item. */
export async function createLinkToken(
  context: FinanceContext,
  requestPlaid: PlaidRequest,
) {
  requireEncryptionKey(context.env);
  const result = await requestLinkToken(context, requestPlaid, {
    products: ["transactions"],
    transactions: { days_requested: 730 },
  });
  console.log({
    event: "plaid_link_token_created",
    mode: "create",
    organizationId: context.get("organizationId"),
    requestId: result.requestId,
  });
  return respond(context, financeRoutes.createLinkToken, {
    expiration: result.expiration,
    linkToken: result.linkToken,
  });
}

/**
 * Starts Plaid Link in update mode for an existing connection, so a user can
 * repair its login (ITEM_LOGIN_REQUIRED, expiring consent) without
 * disconnecting. The Item, access token, and sync cursor stay the same, so the
 * next sync resumes where the last one stopped. Update mode takes no products.
 */
export async function createUpdateLinkToken(
  context: FinanceContext,
  requestPlaid: PlaidRequest,
) {
  const secret = requireEncryptionKey(context.env);
  const organizationId = context.get("organizationId");
  const item = await context.env.DB.prepare(
    `SELECT id, access_token_ciphertext, access_token_iv FROM plaid_items
     WHERE id = ? AND organization_id = ? AND status IN ('active', 'error')`,
  )
    .bind(context.req.param("id") ?? "", organizationId)
    .first<{
      access_token_ciphertext: string;
      access_token_iv: string;
      id: string;
    }>();
  if (!item) {
    return context.json(
      { error: "Connection not found or disconnected." },
      404,
    );
  }
  const accessToken = await decryptToken(
    { ciphertext: item.access_token_ciphertext, iv: item.access_token_iv },
    secret,
    `${organizationId}:${item.id}`,
  );
  const result = await requestLinkToken(context, requestPlaid, {
    access_token: accessToken,
  });
  console.log({
    event: "plaid_link_token_created",
    mode: "update",
    connectionId: item.id,
    organizationId,
    requestId: result.requestId,
  });
  return respond(context, financeRoutes.createUpdateLinkToken, {
    expiration: result.expiration,
    linkToken: result.linkToken,
  });
}

async function requestLinkToken(
  context: FinanceContext,
  requestPlaid: PlaidRequest,
  mode: Record<string, unknown>,
) {
  const result = await requestPlaid<LinkTokenResponse>(
    context.env,
    "/link/token/create",
    {
      client_name: productName,
      country_codes: ["US"],
      language: "en",
      user: {
        client_user_id: clientUserId(
          context.get("organizationId"),
          context.get("authSession").user.id,
        ),
      },
      ...mode,
      ...(context.env.PLAID_REDIRECT_URI
        ? { redirect_uri: context.env.PLAID_REDIRECT_URI }
        : {}),
    },
  );
  return {
    expiration: result.expiration,
    linkToken: result.link_token,
    requestId: result.request_id ?? null,
  };
}

/**
 * Logs what Plaid Link reported for a session. Errors inside Link (after the
 * bank login, before onSuccess) never reach another route, so this is the
 * only server-side record of them. The body carries no credentials or tokens.
 */
export async function reportLinkDiagnostics(context: FinanceContext) {
  const input = await readBody(
    context,
    financeRoutes.reportLinkDiagnostics,
    "Invalid Plaid Link diagnostics.",
  );
  if (input instanceof Response) return input;
  const log = input.error ? console.error : console.log;
  log({
    event: "plaid_link_diagnostics",
    organizationId: context.get("organizationId"),
    userId: context.get("authSession").user.id,
    ...input,
  });
  return context.body(null, 204);
}

export function requireEncryptionKey(env: Bindings) {
  if (!env.PLAID_TOKEN_ENCRYPTION_KEY) {
    throw new PlaidApiError("Plaid is not configured.", "NOT_CONFIGURED", 503);
  }
  return env.PLAID_TOKEN_ENCRYPTION_KEY;
}

function clientUserId(organizationId: string, userId: string) {
  return `${organizationId}:${userId}`.slice(0, 128);
}
