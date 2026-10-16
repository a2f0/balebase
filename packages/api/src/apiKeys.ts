import { type Context, Hono } from "hono";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { canManageOrganization } from "./organizationMembers";
import type { Bindings } from "./types";

export type ApiKeyAccess = "read" | "write";

/** The key behind an API-key request, set beside the creator's session. */
export interface ApiKeyPrincipal {
  access: ApiKeyAccess;
  id: string;
  organizationId: string;
}

type ApiKeysEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};
type ApiKeysContext = Context<ApiKeysEnv>;

interface ApiKeyRow {
  access: ApiKeyAccess;
  created_at: string;
  creator_email: string;
  creator_id: string;
  creator_name: string;
  creator_role: string | null;
  expires_at: string | null;
  id: string;
  last_used_at: string | null;
  name: string;
  revoked_at: string | null;
  revoker_email: string | null;
  revoker_id: string | null;
  revoker_name: string | null;
  token_prefix: string;
}

interface CredentialRow {
  access: ApiKeyAccess;
  banExpires: string | number | null;
  banned: number | boolean | null;
  createdAt: string | number;
  defaultOrganizationId: string | null;
  email: string;
  emailVerified: number | boolean;
  expires_at: string | null;
  id: string;
  image: string | null;
  last_used_at: string | null;
  member_role: string | null;
  name: string;
  organization_id: string;
  revoked_at: string | null;
  twoFactorEnabled: number | boolean | null;
  two_factor_verified: number;
  updatedAt: string | number;
  user_id: string;
}

export type ApiKeyAuthentication =
  | {
      ok: true;
      principal: ApiKeyPrincipal;
      session: AuthSession;
      /** Whether `last_used_at` is stale enough to be worth a write. */
      stale: boolean;
    }
  | { error: string; ok: false; status: 401 | 403 };

const tokenPrefix = "tlk_";
const tokenPattern = /^tlk_[0-9a-f]{64}$/;
// "tlk_" and eight hex digits: enough to tell keys apart, useless to guess.
const displayPrefixLength = 12;
const maxNameLength = 100;
const maxActiveKeys = 50;
const expirationDays = [30, 90, 365] as const;
const lastUsedPrecisionMs = 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;

/**
 * Workspace routes an API key may call. Account, billing, platform admin,
 * Better Auth, and API key management stay session-only, so a leaked key
 * cannot mint more keys, change sign-in security, or touch billing.
 */
const apiKeyRoutes: Array<{ prefix: string; writable: boolean }> = [
  { prefix: "/api/me", writable: false },
  { prefix: "/api/activity", writable: false },
  { prefix: "/api/audits", writable: true },
  { prefix: "/api/businesses", writable: true },
  { prefix: "/api/contracts", writable: true },
  { prefix: "/api/employee-forms", writable: true },
  { prefix: "/api/equipment", writable: true },
  { prefix: "/api/finance", writable: true },
  { prefix: "/api/inbox", writable: true },
  { prefix: "/api/library/folders", writable: true },
  { prefix: "/api/objects", writable: true },
  { prefix: "/api/organization-groups", writable: true },
  { prefix: "/api/organization-settings/people", writable: false },
];

const safeMethods = new Set(["GET", "HEAD"]);

/** The bearer token, when the Authorization header carries an API key. */
export function apiKeyFromHeader(header: string | undefined) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match?.[1]?.startsWith(tokenPrefix) ? match[1] : undefined;
}

/** Why this key may not make this request, or undefined when it may. */
export function apiKeyRouteDenial(
  path: string,
  method: string,
  access: ApiKeyAccess,
) {
  const route = apiKeyRoutes.find(
    ({ prefix }) => path === prefix || path.startsWith(`${prefix}/`),
  );
  if (!route) return "API keys cannot access this endpoint.";
  if (safeMethods.has(method)) return undefined;
  if (!route.writable) return "This endpoint is read-only for API keys.";
  return access === "write" ? undefined : "This API key is read-only.";
}

/**
 * Resolves a bearer token to its key and its creator. The creator must still
 * own or administer the organization; the organization middleware then
 * applies the same seat and two-factor rules as a session.
 */
export async function authenticateApiKey(
  database: D1Database,
  token: string,
  now: Date,
): Promise<ApiKeyAuthentication> {
  const invalid = {
    error: "Invalid API key.",
    ok: false,
    status: 401,
  } as const;
  if (!tokenPattern.test(token)) return invalid;
  const row = await database
    .prepare(
      `SELECT api_key.id, api_key.organization_id, api_key.access,
              api_key.expires_at, api_key.last_used_at, api_key.revoked_at,
              api_key.two_factor_verified,
              member.role AS member_role,
              user.id AS user_id, user.name, user.email, user.emailVerified,
              user.image, user.createdAt, user.updatedAt, user.banned,
              user.banExpires, user.twoFactorEnabled,
              user.defaultOrganizationId
       FROM organization_api_keys AS api_key
       JOIN organization ON organization.id = api_key.organization_id
       JOIN user ON user.id = api_key.created_by
       LEFT JOIN member
         ON member.organizationId = api_key.organization_id
        AND member.userId = api_key.created_by
       WHERE api_key.token_hash = ? AND organization.deletedAt IS NULL`,
    )
    .bind(await hashToken(token))
    .first<CredentialRow>();
  if (!row) return invalid;
  if (row.revoked_at) {
    return { error: "This API key has been revoked.", ok: false, status: 401 };
  }
  if (row.expires_at && Date.parse(row.expires_at) <= now.getTime()) {
    return { error: "This API key has expired.", ok: false, status: 401 };
  }
  if (!row.member_role || !canManageOrganization(row.member_role)) {
    return {
      error:
        "This API key is inactive because the person who created it no longer manages this organization.",
      ok: false,
      status: 403,
    };
  }
  if (isBanned(row, now)) {
    return {
      error: "This API key's creator is banned.",
      ok: false,
      status: 403,
    };
  }
  return {
    ok: true,
    principal: {
      access: row.access,
      id: row.id,
      organizationId: row.organization_id,
    },
    session: apiKeySession(row, now),
    stale:
      !row.last_used_at ||
      now.getTime() - Date.parse(row.last_used_at) >= lastUsedPrecisionMs,
  };
}

/** Records use at minute precision so busy keys do not write every call. */
export async function recordApiKeyUse(
  database: D1Database,
  keyId: string,
  usedAt: Date,
) {
  const threshold = new Date(usedAt.getTime() - lastUsedPrecisionMs);
  try {
    await database
      .prepare(
        `UPDATE organization_api_keys SET last_used_at = ?
         WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
      )
      .bind(usedAt.toISOString(), keyId, threshold.toISOString())
      .run();
  } catch (cause) {
    console.error("Could not record API key use.", cause);
  }
}

/**
 * The creator's identity, limited to this organization. API keys never carry
 * the platform admin role. A key counts as two-factor verified only if the
 * session that created it was, and only while its creator keeps two-factor
 * authentication enabled; otherwise a later requirement needs a new key.
 */
function apiKeySession(row: CredentialRow, now: Date) {
  const twoFactorEnabled = Boolean(row.twoFactorEnabled);
  const twoFactorVerified = twoFactorEnabled && row.two_factor_verified === 1;
  return {
    session: {
      activeOrganizationId: row.organization_id,
      activeTeamId: null,
      createdAt: now,
      expiresAt: now,
      id: `api-key:${row.id}`,
      impersonatedBy: null,
      ipAddress: null,
      token: "",
      twoFactorVerified,
      updatedAt: now,
      userAgent: null,
      userId: row.user_id,
    },
    user: {
      banned: false,
      banExpires: null,
      banReason: null,
      createdAt: new Date(row.createdAt),
      defaultOrganizationId: row.defaultOrganizationId,
      email: row.email,
      emailVerified: Boolean(row.emailVerified),
      id: row.user_id,
      image: row.image,
      name: row.name,
      role: "user",
      twoFactorEnabled,
      updatedAt: new Date(row.updatedAt),
    },
  } as unknown as AuthSession;
}

function isBanned(row: CredentialRow, now: Date) {
  if (!row.banned) return false;
  if (row.banExpires === null) return true;
  return new Date(row.banExpires).getTime() > now.getTime();
}

const apiKeys = new Hono<ApiKeysEnv>();

apiKeys.use("*", async (context, next) => {
  if (!canManageOrganization(context.get("organizationRole"))) {
    return context.json(
      { error: "Organization manager access required." },
      403,
    );
  }
  return next();
});

apiKeys.get("/", async (context) => {
  const result = await context.env.DB.prepare(
    `${apiKeySelect} WHERE api_key.organization_id = ?
     ORDER BY api_key.created_at DESC, api_key.id DESC`,
  )
    .bind(context.get("organizationId"))
    .all<ApiKeyRow>();
  const now = new Date();
  return context.json({
    apiKeys: result.results.map((row) => toApiKey(row, now)),
  });
});

apiKeys.post("/", async (context) => {
  const session = context.get("authSession");
  // A key would outlive the impersonation that created it.
  if (session.session.impersonatedBy) {
    return context.json(
      { error: "API keys cannot be created while impersonating a user." },
      403,
    );
  }
  const input = parseApiKeyInput(await context.req.json().catch(() => null));
  if (typeof input === "string") return context.json({ error: input }, 400);
  const organizationId = context.get("organizationId");
  const now = new Date();
  const id = crypto.randomUUID();
  const token = newToken();
  const expiresAt =
    input.expiresInDays === null
      ? null
      : new Date(now.getTime() + input.expiresInDays * dayMs).toISOString();
  // The limit is checked in the INSERT itself so concurrent requests cannot
  // both pass a separate count.
  const inserted = await context.env.DB.prepare(
    `INSERT INTO organization_api_keys
       (id, organization_id, name, access, token_prefix, token_hash,
        created_by, created_at, two_factor_verified, expires_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM organization_api_keys
            WHERE organization_id = ? AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > ?)) < ?`,
  )
    .bind(
      id,
      organizationId,
      input.name,
      input.access,
      token.slice(0, displayPrefixLength),
      await hashToken(token),
      session.user.id,
      now.toISOString(),
      session.session.twoFactorVerified ? 1 : 0,
      expiresAt,
      organizationId,
      now.toISOString(),
      maxActiveKeys,
    )
    .run();
  if (inserted.meta.changes === 0) {
    return context.json(
      {
        error: `An organization can have at most ${maxActiveKeys} active API keys. Revoke one before creating another.`,
      },
      409,
    );
  }
  const created = await findApiKey(context.env.DB, organizationId, id);
  if (!created) throw new Error("The new API key could not be read back.");
  return context.json({ apiKey: toApiKey(created, now), token }, 201);
});

apiKeys.delete("/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const id = context.req.param("id");
  await context.env.DB.prepare(
    `UPDATE organization_api_keys SET revoked_at = ?, revoked_by = ?
     WHERE id = ? AND organization_id = ? AND revoked_at IS NULL`,
  )
    .bind(
      new Date().toISOString(),
      context.get("authSession").user.id,
      id,
      organizationId,
    )
    .run();
  const revoked = await findApiKey(context.env.DB, organizationId, id);
  if (!revoked) return notFound(context);
  return context.json({ apiKey: toApiKey(revoked, new Date()) });
});

const apiKeySelect = `
  SELECT api_key.id, api_key.name, api_key.access, api_key.token_prefix,
         api_key.created_at, api_key.expires_at, api_key.last_used_at,
         api_key.revoked_at,
         creator.id AS creator_id, creator.name AS creator_name,
         creator.email AS creator_email, creator_member.role AS creator_role,
         revoker.id AS revoker_id, revoker.name AS revoker_name,
         revoker.email AS revoker_email
  FROM organization_api_keys AS api_key
  JOIN user AS creator ON creator.id = api_key.created_by
  LEFT JOIN member AS creator_member
    ON creator_member.organizationId = api_key.organization_id
   AND creator_member.userId = api_key.created_by
  LEFT JOIN user AS revoker ON revoker.id = api_key.revoked_by`;

function findApiKey(database: D1Database, organizationId: string, id: string) {
  return database
    .prepare(
      `${apiKeySelect} WHERE api_key.organization_id = ? AND api_key.id = ?`,
    )
    .bind(organizationId, id)
    .first<ApiKeyRow>();
}

function toApiKey(row: ApiKeyRow, now: Date) {
  return {
    access: row.access,
    createdAt: row.created_at,
    createdBy: {
      email: row.creator_email,
      id: row.creator_id,
      name: row.creator_name,
    },
    expiresAt: row.expires_at,
    id: row.id,
    lastUsedAt: row.last_used_at,
    name: row.name,
    prefix: row.token_prefix,
    revokedAt: row.revoked_at,
    revokedBy: row.revoker_id
      ? {
          email: row.revoker_email ?? "",
          id: row.revoker_id,
          name: row.revoker_name ?? "",
        }
      : null,
    status: apiKeyStatus(row, now),
  };
}

function apiKeyStatus(row: ApiKeyRow, now: Date) {
  if (row.revoked_at) return "revoked" as const;
  if (row.expires_at && Date.parse(row.expires_at) <= now.getTime()) {
    return "expired" as const;
  }
  if (!row.creator_role || !canManageOrganization(row.creator_role)) {
    return "inactive" as const;
  }
  return "active" as const;
}

function parseApiKeyInput(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return "A name, access level, and expiration are required.";
  }
  const { access, expiresInDays, name } = value as Record<string, unknown>;
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName || trimmedName.length > maxNameLength) {
    return `Name the API key with 1 to ${maxNameLength} characters.`;
  }
  if (access !== "read" && access !== "write") {
    return 'Access must be "read" or "write".';
  }
  if (
    expiresInDays !== null &&
    !expirationDays.some((days) => days === expiresInDays)
  ) {
    return `Expiration must be ${expirationDays.join(", ")} days, or null for no expiration.`;
  }
  return {
    access: access as ApiKeyAccess,
    expiresInDays: expiresInDays as (typeof expirationDays)[number] | null,
    name: trimmedName,
  };
}

function newToken() {
  return `${tokenPrefix}${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return hex(new Uint8Array(digest));
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function notFound(context: ApiKeysContext) {
  return context.json({ error: "API key not found." }, 404);
}

export { apiKeys };
