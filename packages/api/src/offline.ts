import {
  OfflineScopeSchema,
  offlineRoutes,
} from "@balebase/validators/offline";
import { Hono } from "hono";
import { activityBatch } from "./activity";
import { findIssueImages } from "./auditIssueImageRecords";
import { uploadAuditIssueImage } from "./auditIssueImages";
import {
  ensureStarterTemplates,
  type TemplateRow,
  templateSelect,
  toTemplate,
} from "./auditTemplates";
import type { ApiEnv } from "./authMiddleware";
import type { IssueContext } from "./issueRecords";
import { offlineStatements } from "./offlineRecords";
import { listMemberDirectory } from "./organizationMembers";
import { respond } from "./respond";

export const offline = new Hono<ApiEnv>();

offline.get("/issues/:issueId/images", async (context) =>
  respond(context, offlineRoutes.images, {
    images: await findIssueImages(
      context.env.DB,
      context.get("organizationId"),
      context.req.param("issueId"),
    ),
  }),
);

offline.get("/forms", async (context) => {
  const scope = OfflineScopeSchema.safeParse(context.req.query());
  if (!scope.success || !matchesScope(context, scope.data))
    return context.json(
      {
        error:
          "The active account or organization changed. Reload before downloading.",
      },
      403,
    );
  await ensureStarterTemplates(context.env.DB);
  const templates = await context.env.DB.prepare(`${templateSelect}
    WHERE (family.scope = 'global' AND version.status = 'published') OR family.organization_id = ?
    ORDER BY family.updated_at DESC`)
    .bind(scope.data.organizationId)
    .all<TemplateRow>();
  return respond(context, offlineRoutes.forms, {
    templates: templates.results.map(toTemplate),
    members: await listMemberDirectory(
      context.env.DB,
      scope.data.organizationId,
    ),
  });
});

offline.post("/operations", async (context) => {
  const parsed = offlineRoutes.apply.body.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success)
    return context.json({ error: "Invalid offline operation." }, 400);
  const { operation, ...scope } = parsed.data;
  if (!matchesScope(context, scope))
    return context.json(
      {
        error:
          "Sign in to the original account and organization to sync this work.",
      },
      403,
    );
  const digestBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(operation)),
  );
  const digest = Array.from(new Uint8Array(digestBytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const receipt = () =>
    context.env.DB.prepare(
      "SELECT digest FROM offline_operations WHERE organization_id = ? AND user_id = ? AND id = ?",
    )
      .bind(scope.organizationId, scope.userId, operation.id)
      .first<{ digest: string }>();
  const existing = await receipt();
  if (existing) return replay(context, operation.id, digest, existing.digest);
  const statements = await offlineStatements(context, operation);
  if (typeof statements === "string")
    return context.json({ error: statements }, 409);
  try {
    await activityBatch(context.env.DB, context.get("apiKey"), [
      context.env.DB.prepare(
        "INSERT INTO offline_operations (organization_id, user_id, id, digest, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        scope.organizationId,
        scope.userId,
        operation.id,
        digest,
        new Date().toISOString(),
      ),
      ...statements,
    ]);
  } catch (cause) {
    // A second tab or a response lost after commit is the same operation.
    const committed = await receipt();
    if (committed)
      return replay(context, operation.id, digest, committed.digest);
    const validation = await offlineStatements(context, operation);
    if (typeof validation === "string")
      return context.json({ error: validation }, 409);
    throw cause;
  }
  return respond(
    context,
    offlineRoutes.apply,
    { resourceId: operation.id },
    201,
  );
});

offline.put("/issues/:issueId/images/:imageId", async (context) => {
  const scope = OfflineScopeSchema.safeParse(context.req.query());
  if (!scope.success || !matchesScope(context, scope.data)) {
    return context.json(
      {
        error:
          "Sign in to the original account and organization to sync this image.",
      },
      403,
    );
  }
  return uploadAuditIssueImage(context, context.req.param("imageId"));
});

function matchesScope(
  context: IssueContext,
  scope: { userId: string; organizationId: string },
) {
  return (
    scope.userId === context.get("authSession").user.id &&
    scope.organizationId === context.get("organizationId")
  );
}

function replay(
  context: IssueContext,
  id: string,
  expected: string,
  actual: string,
) {
  return expected === actual
    ? respond(context, offlineRoutes.apply, { resourceId: id })
    : context.json(
        {
          error:
            "This offline operation was already synced with different content.",
        },
        409,
      );
}
