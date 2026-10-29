import type { ApiKeyAccess } from "@balebase/validators/apiKeys";
import type { Bindings } from "../types";
import type { AuthSession } from "./auth";

/** Whether an API-key request came from an MCP tool or straight to REST. */
export type ApiKeyChannel = "mcp" | "rest";

/** The key behind an API-key request, set beside the creator's session. */
export interface ApiKeyPrincipal {
  access: ApiKeyAccess;
  channel: ApiKeyChannel;
  id: string;
  organizationId: string;
}

export interface AuthVariables {
  /** Set when an API key, rather than a session, authenticated the request. */
  apiKey?: ApiKeyPrincipal;
  authSession: AuthSession;
  organizationId: string;
  organizationRole: string;
}

/** The Hono environment every API router and context is typed with. */
export type ApiEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};
