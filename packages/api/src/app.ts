import { sessionRoutes } from "@balebase/validators/session";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { version as apiVersion } from "../package.json";
import { accountSettings } from "./accountSettings";
import { activity } from "./activity";
import { adminAuditTemplates } from "./adminAuditTemplates";
import { adminJobs } from "./adminJobs";
import { adminOrganizations } from "./adminOrganizations";
import { adminUsers } from "./adminUsers";
import { apiKeys, mcpToolRequest } from "./apiKeys";
import { audits } from "./audits";
import { createAuth } from "./auth";
import {
  type AuthVariables,
  requireApiKey,
  requireAuth,
  requireAuthOrganizationSeat,
  requireBillingOrganization,
  requireOrganization,
  requireOrganizationPluginAccess,
  requireRole,
} from "./authMiddleware";
import { billing, handleStripeWebhook, syncOrganizationSeats } from "./billing";
import { businesses } from "./businesses";
import { handleCheckrWebhook } from "./checkrSync";
import { contracts } from "./contracts";
import { employeeForms } from "./employeeForms";
import { equipment } from "./equipment";
import { finance } from "./finance";
import { inbox } from "./inbox";
import { issues } from "./issues";
import { libraryFolders } from "./libraryFolders";
import { withNativeOrigin } from "./nativeRequest";
import { objects } from "./objects";
import { offline } from "./offline";
import { organizationGroups, requireCapability } from "./organizationGroups";
import { organizationSettings } from "./organizationSettings";
import { respond } from "./respond";
import { signing } from "./signing";
import type { Bindings } from "./types";
import { respondToUnexpectedError } from "./unexpectedError";
import { userDeletion } from "./userDeletion";

const apiVersionHeader = "API-Version";

const app = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

// Every response names the API version, errors and preflights included, so
// the client can show which deploy answered.
app.use("*", async (context, next) => {
  await next();
  context.header(apiVersionHeader, apiVersion);
});

app.use("/api/*", async (context, next) => {
  context.req.raw = withNativeOrigin(context.req.raw, context.env.CORS_ORIGIN);
  await next();
});

app.use(
  "/api/*",
  cors({
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
    exposeHeaders: ["Retry-After", "X-Document-Revision", apiVersionHeader],
    origin: (origin, context) =>
      origin === context.env.CORS_ORIGIN ? origin : undefined,
  }),
);

app.use(
  "/api/auth/organization/*",
  requireAuth,
  requireOrganizationPluginAccess,
  requireAuthOrganizationSeat,
);
app.post("/api/auth/organization/leave", async (context) => {
  const input = (await context.req.raw
    .clone()
    .json()
    .catch(() => null)) as { organizationId?: unknown } | null;
  const response = await createAuth(context.env, (promise) =>
    context.executionCtx.waitUntil(promise),
  ).handler(context.req.raw);
  if (response.ok && typeof input?.organizationId === "string") {
    context.executionCtx.waitUntil(
      syncOrganizationSeats(context.env, input.organizationId).catch(
        (cause) => {
          console.error("Could not synchronize Stripe seat quantity.", cause);
        },
      ),
    );
  }
  return response;
});
app.all("/api/auth/*", (context) =>
  createAuth(context.env, (promise) =>
    context.executionCtx.waitUntil(promise),
  ).handler(context.req.raw),
);

app.get("/", (context) =>
  context.json({ name: "balebase-api", documentation: "/api" }),
);

app.get("/health", (context) =>
  context.json({ status: "ok", timestamp: new Date().toISOString() }),
);

app.get("/api", (context) =>
  context.json({
    endpoints: {
      adminAuditTemplates: "/api/admin/audit-templates",
      adminJobs: "/api/admin/jobs",
      adminOrganizations: "/api/admin/organizations",
      adminUsers: "/api/admin/users",
      accountSettings: "/api/account-settings",
      apiKeys: "/api/organization-settings/api-keys",
      activity: "/api/activity",
      issues: "/api/issues",
      audits: "/api/audits",
      billing: "/api/billing",
      businesses: "/api/businesses",
      contracts: "/api/contracts",
      equipment: "/api/equipment",
      employeeForms: "/api/employee-forms",
      finance: "/api/finance",
      inbox: "/api/inbox",
      libraryFolders: "/api/library/folders",
      mcp: "/mcp",
      objects: "/api/objects",
      organizationGroups: "/api/organization-groups",
      organizationSettings: "/api/organization-settings",
      session: "/api/me",
      signing: "/api/signing/:token",
      health: "/health",
    },
  }),
);

app.get("/api/me", requireAuth, (context) => {
  const apiKey = context.get("apiKey");
  return respond(context, sessionRoutes.me, {
    user: context.get("authSession").user,
    ...(apiKey ? { apiKey } : {}),
  });
});

// MCP clients authenticate with an organization API key. Tools call back into
// this app, so every REST route's own authorization applies to them.
app.all(
  "/mcp",
  async (context, next) => {
    // Browsers never need this endpoint. Refusing foreign origins follows the
    // MCP transport's DNS-rebinding guidance; native clients send no Origin.
    const origin = context.req.header("Origin");
    if (origin !== undefined && origin !== context.env.CORS_ORIGIN) {
      return context.json({ error: "Untrusted request origin." }, 403);
    }
    return next();
  },
  requireApiKey,
  requireOrganization,
  async (context) => {
    // The SDK preloads its schemas when it loads; importing it on first use
    // keeps that work out of every isolate's startup.
    const { handleMcpRequest } = await import("./mcp");
    return handleMcpRequest(context, (request) =>
      app.fetch(mcpToolRequest(request), context.env, context.executionCtx),
    );
  },
);

app.get("/api/admin", requireAuth, requireRole("admin"), (context) =>
  respond(context, sessionRoutes.admin, {
    user: context.get("authSession").user,
  }),
);

app.use("/api/account-settings/*", requireAuth);
app.route("/api/account-settings", accountSettings);
app.route("/api/account-settings/deletion", userDeletion);

app.use("/api/admin/jobs", requireAuth);
app.use("/api/admin/jobs/*", requireAuth);
app.route("/api/admin/jobs", adminJobs);

app.use("/api/admin/audit-templates", requireAuth, requireRole("admin"));
app.use("/api/admin/audit-templates/*", requireAuth, requireRole("admin"));
app.route("/api/admin/audit-templates", adminAuditTemplates);

app.use("/api/admin/organizations", requireAuth, requireRole("admin"));
app.use("/api/admin/organizations/*", requireAuth, requireRole("admin"));
app.route("/api/admin/organizations", adminOrganizations);

app.use("/api/admin/users", requireAuth);
app.use("/api/admin/users/*", requireAuth);
app.route("/api/admin/users", adminUsers);

app.use("/api/audits", requireAuth, requireOrganization);
app.use("/api/audits/*", requireAuth, requireOrganization);
app.route("/api/audits", audits);

app.use("/api/activity", requireAuth, requireOrganization);
app.use("/api/activity/*", requireAuth, requireOrganization);
app.route("/api/activity", activity);

app.use("/api/issues", requireAuth, requireOrganization);
app.use("/api/issues/*", requireAuth, requireOrganization);
app.route("/api/issues", issues);

app.use("/api/offline/*", requireAuth, requireOrganization);
app.route("/api/offline", offline);

app.use("/api/businesses", requireAuth, requireOrganization);
app.use("/api/businesses/*", requireAuth, requireOrganization);
app.route("/api/businesses", businesses);

app.use("/api/contracts", requireAuth, requireOrganization);
app.use("/api/contracts/*", requireAuth, requireOrganization);
app.route("/api/contracts", contracts);

// Signers reach these through emailed links; the token is the credential.
app.route("/api/signing", signing);

app.use("/api/equipment", requireAuth, requireOrganization);
app.use("/api/equipment/*", requireAuth, requireOrganization);
app.route("/api/equipment", equipment);

// Checkr signs these with the account API key; no session is involved.
app.post("/api/checkr/webhook", handleCheckrWebhook);

app.use("/api/employee-forms", requireAuth, requireOrganization);
app.use("/api/employee-forms/*", requireAuth, requireOrganization);
app.route("/api/employee-forms", employeeForms);

app.post("/api/billing/webhook", handleStripeWebhook);
app.use("/api/billing", requireAuth, requireBillingOrganization);
app.use("/api/billing/*", requireAuth, requireBillingOrganization);
app.route("/api/billing", billing);

app.use("/api/inbox", requireAuth, requireOrganization);
app.use("/api/inbox/*", requireAuth, requireOrganization);
app.route("/api/inbox", inbox);

app.use(
  "/api/finance",
  requireAuth,
  requireOrganization,
  requireCapability("finance"),
);
app.use(
  "/api/finance/*",
  requireAuth,
  requireOrganization,
  requireCapability("finance"),
);
app.route("/api/finance", finance);

app.use("/api/organization-groups", requireAuth, requireOrganization);
app.use("/api/organization-groups/*", requireAuth, requireOrganization);
app.route("/api/organization-groups", organizationGroups);

app.use("/api/organization-settings", requireAuth);
app.use("/api/organization-settings/*", requireAuth);
app.use("/api/organization-settings/people", requireOrganization);
app.use("/api/organization-settings/people/*", requireOrganization);
app.use("/api/organization-settings/current", requireOrganization);
app.use("/api/organization-settings/api-keys", requireOrganization);
app.use("/api/organization-settings/api-keys/*", requireOrganization);
app.route("/api/organization-settings/api-keys", apiKeys);
app.route("/api/organization-settings", organizationSettings);

app.use("/api/library/folders", requireAuth, requireOrganization);
app.use("/api/library/folders/*", requireAuth, requireOrganization);
app.route("/api/library/folders", libraryFolders);

app.use("/api/objects", requireAuth, requireOrganization);
app.use("/api/objects/*", requireAuth, requireOrganization);
app.route("/api/objects", objects);

app.notFound((context) => context.json({ error: "Not found." }, 404));

app.onError(respondToUnexpectedError);

export { app };
