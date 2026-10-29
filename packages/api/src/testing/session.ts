import { type Context, Hono } from "hono";
import type { AuthSession } from "../auth/auth";
import type { AuthVariables } from "../auth/authMiddleware";
import type { Bindings } from "../types";

export type ApiTestEnv = { Bindings: Bindings; Variables: AuthVariables };

export interface TestIdentity {
  /** Defaults to "user-1". */
  userId?: string | undefined;
  /** The platform role, "user" unless set. */
  role?: string | undefined;
  email?: string | undefined;
  name?: string | undefined;
  /** Sets the request's organization, as requireOrganization would. */
  organizationId?: string | undefined;
  organizationRole?: string | undefined;
  session?: Partial<AuthSession["session"]>;
  user?: Partial<AuthSession["user"]>;
}

/** The signed-in session requireAuth would attach for this identity. */
function testSession(identity: TestIdentity = {}): AuthSession {
  const userId = identity.userId ?? "user-1";
  const organization =
    identity.organizationId === undefined
      ? {}
      : { activeOrganizationId: identity.organizationId };
  return {
    session: {
      id: `session-${userId}`,
      twoFactorVerified: false,
      userId,
      ...organization,
      ...identity.session,
    },
    user: {
      id: userId,
      role: identity.role ?? "user",
      twoFactorEnabled: false,
      ...(identity.email === undefined ? {} : { email: identity.email }),
      ...(identity.name === undefined ? {} : { name: identity.name }),
      ...(identity.organizationId === undefined
        ? {}
        : { defaultOrganizationId: identity.organizationId }),
      ...identity.user,
    },
  } as AuthSession;
}

/**
 * Authenticates every request as `identity`, standing in for requireAuth and
 * requireOrganization. Pass a function to choose the identity per request.
 */
export function withTestSession(
  identity: TestIdentity | ((context: Context<ApiTestEnv>) => TestIdentity),
) {
  return async (context: Context<ApiTestEnv>, next: () => Promise<void>) => {
    const current =
      typeof identity === "function" ? identity(context) : identity;
    context.set("authSession", testSession(current));
    if (current.organizationId !== undefined)
      context.set("organizationId", current.organizationId);
    if (current.organizationRole !== undefined)
      context.set("organizationRole", current.organizationRole);
    await next();
  };
}

/** Mounts `routes` behind a test session for `identity`. */
export function testApp(
  routes: Record<string, Hono<ApiTestEnv>>,
  identity: Parameters<typeof withTestSession>[0] = {},
) {
  const app = new Hono<ApiTestEnv>();
  app.use("*", withTestSession(identity));
  for (const [path, route] of Object.entries(routes)) app.route(path, route);
  return app;
}
