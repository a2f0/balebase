import { fetchApi } from "./apiVersion";
import { apiUrl } from "./config";

export type ApiKeyAccess = "read" | "write";
export type ApiKeyExpiration = 30 | 90 | 365 | null;

export interface ApiKey {
  access: ApiKeyAccess;
  createdAt: string;
  createdBy: { email: string; id: string; name: string };
  expiresAt: string | null;
  id: string;
  lastUsedAt: string | null;
  name: string;
  /** The token's first characters, enough to recognize it. */
  prefix: string;
  revokedAt: string | null;
  revokedBy: { email: string; id: string; name: string } | null;
  /** `inactive` keys belong to someone who no longer manages the organization. */
  status: "active" | "expired" | "inactive" | "revoked";
}

/** The MCP endpoint that accepts these keys. */
export const mcpServerUrl = `${apiUrl}/mcp`;

export async function listApiKeys() {
  const body = await request<{ apiKeys: ApiKey[] }>("");
  return body.apiKeys;
}

export function createApiKey(input: {
  access: ApiKeyAccess;
  expiresInDays: ApiKeyExpiration;
  name: string;
}) {
  return request<{ apiKey: ApiKey; token: string }>("", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function revokeApiKey(id: string) {
  const body = await request<{ apiKey: ApiKey }>(`/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return body.apiKey;
}

async function request<T>(path: string, init?: RequestInit) {
  const response = await fetchApi(
    `${apiUrl}/api/organization-settings/api-keys${path}`,
    {
      ...init,
      credentials: "include",
      headers: init?.body ? { "Content-Type": "application/json" } : {},
    },
  );
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new Error(
    body?.error ?? `Request failed with status ${response.status}.`,
  );
}
