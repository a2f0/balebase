import { productName } from "@balebase/ui/brand";
import { financeRoutes } from "@balebase/validators/finance";
import {
  activityBatch,
  requestActor,
  rowActivityStatement,
} from "../shared/activity";
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
  await storeRepairSession(context, item.id, result);
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

/** As long as Plaid's link tokens last by default. */
const repairSessionMilliseconds = 4 * 60 * 60 * 1_000;

/**
 * Remembers an update-mode Link session, so the app can report its success
 * once (`reportLoginRepair`). Only the link token's hash is kept, until the
 * report or four hours; expired sessions are cleared here.
 */
async function storeRepairSession(
  context: FinanceContext,
  connectionId: string,
  linkToken: { linkToken: string },
) {
  const database = context.env.DB;
  await database.batch([
    database
      .prepare(
        "DELETE FROM finance_login_repair_sessions WHERE expires_at <= ?",
      )
      .bind(new Date().toISOString()),
    database
      .prepare(
        `INSERT OR REPLACE INTO finance_login_repair_sessions
           (link_token_hash, organization_id, connection_id, user_id,
            expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        await tokenHash(linkToken.linkToken),
        context.get("organizationId"),
        connectionId,
        context.get("authSession").user.id,
        new Date(Date.now() + repairSessionMilliseconds).toISOString(),
      ),
  ]);
}

/**
 * Records the app's report that Link update mode succeeded for this
 * connection, so a repaired bank login has its own event, apart from the
 * sync that follows. Plaid tells only the browser, so the event is the app's
 * report, not Plaid's confirmation. It must carry the link token of an
 * unexpired update session the same person opened for this connection, and
 * each session is accepted once, so a report cannot be replayed or made up
 * without opening Link. The event holds the connection's status and error
 * code before the repair, never Plaid tokens or Item IDs.
 */
export async function reportLoginRepair(context: FinanceContext) {
  const input = await readBody(
    context,
    financeRoutes.reportLoginRepair,
    "A Link session is required.",
  );
  if (input instanceof Response) return input;
  const organizationId = context.get("organizationId");
  const connectionId = context.req.param("id") ?? "";
  const actor = requestActor(context);
  const database = context.env.DB;
  const repairSession = {
    bindings: [
      await tokenHash(input.linkToken),
      organizationId,
      connectionId,
      actor.userId,
      new Date().toISOString(),
    ],
    sql: `EXISTS (SELECT 1 FROM finance_login_repair_sessions AS repair
      WHERE repair.link_token_hash = ? AND repair.organization_id = ?
        AND repair.connection_id = ? AND repair.user_id = ?
        AND repair.expires_at > ?)`,
  };
  const [recorded] = await activityBatch(database, actor.apiKey, [
    rowActivityStatement(
      database,
      {
        action: "finance.connection_repaired",
        actorId: actor.userId,
        details: {
          bindings: [],
          sql: `json_object('institutionName', institution_name,
            'statusBefore', status, 'errorCodeBefore', error_code)`,
        },
        id: connectionId,
        label: "COALESCE(institution_name, 'Bank connection')",
        occurredAt: new Date().toISOString(),
        organizationId,
        rootType: "finance_connection",
        table: "plaid_items",
      },
      {
        bindings: repairSession.bindings,
        sql: `status IN ('active', 'error') AND ${repairSession.sql}`,
      },
    ),
    database
      .prepare(
        `DELETE FROM finance_login_repair_sessions
         WHERE link_token_hash = ? AND organization_id = ?
           AND connection_id = ? AND user_id = ?`,
      )
      .bind(...repairSession.bindings.slice(0, 4)),
  ]);
  if (!recorded?.meta.changes) {
    return context.json(
      { error: "No open Link update session for this connection." },
      404,
    );
  }
  return context.body(null, 204);
}

async function tokenHash(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
