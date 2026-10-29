import { sessionRoutes } from "@balebase/validators/session";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { version as apiVersion } from "../package.json";
import { adminAuditTemplates } from "./admin/adminAuditTemplates";
import { adminJobs } from "./admin/adminJobs";
import { adminOrganizations } from "./admin/adminOrganizations";
import { adminUsers } from "./admin/adminUsers";
import { audits } from "./audits/audits";
import { apiKeys, mcpToolRequest } from "./auth/apiKeys";
import { createAuth } from "./auth/auth";
import {
  type ApiEnv,
  requireApiKey,
  requireAuth,
  requireBillingOrganization,
  requireOrganization,
  requireOrganizationPluginAccess,
  requireRole,
} from "./auth/authMiddleware";
import { withNativeOrigin } from "./auth/nativeRequest";
import { billing } from "./billing/billing";
import { syncOrganizationSeats } from "./billing/billingSeats";
import { handleStripeWebhook } from "./billing/billingWebhook";
import { businesses } from "./businesses/businesses";
import { contracts } from "./contracts/contracts";
import { signing } from "./contracts/signing";
import { handleCheckrWebhook } from "./employeeForms/checkrSync";
import { employeeForms } from "./employeeForms/employeeForms";
import { equipment } from "./equipment/equipment";
import { finance } from "./finance";
import { inbox } from "./inbox";
import { issues } from "./issues/issues";
import { libraryFolders } from "./libraryFolders";
import { objects } from "./objects";
import { offline } from "./offline/offline";
import {
  organizationGroups,
  requireCapability,
} from "./organizations/organizationGroups";
import { organizationSettings } from "./organizations/organizationSettings";
import { activity } from "./shared/activity";
import { respond } from "./shared/respond";
import { respondToUnexpectedError } from "./shared/unexpectedError";
import { accountSettings } from "./users/accountSettings";
import { userDeletion } from "./users/userDeletion";

const apiVersionHeader = "API-Version";

const app = new Hono<ApiEnv>();

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

app.get("/", (context) => context.json({ name: "balebase-api" }));

app.get("/health", (context) =>
  context.json({ status: "ok", timestamp: new Date().toISOString() }),
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

// Mount every admin router below /api/admin so this guard covers it.
app.use("/api/admin/*", requireAuth, requireRole("admin"));
app.get("/api/admin", (context) =>
  respond(context, sessionRoutes.admin, {
    user: context.get("authSession").user,
  }),
);
app.route("/api/admin/jobs", adminJobs);
app.route("/api/admin/audit-templates", adminAuditTemplates);
app.route("/api/admin/organizations", adminOrganizations);
app.route("/api/admin/users", adminUsers);

app.use("/api/account-settings/*", requireAuth);
app.route("/api/account-settings", accountSettings);
app.route("/api/account-settings/deletion", userDeletion);

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
