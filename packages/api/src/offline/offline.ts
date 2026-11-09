import {
  OfflineScopeSchema,
  OfflineSyncQuerySchema,
  offlineRoutes,
} from "@balebase/validators/offline";
import { Hono } from "hono";
import { findIssueImages } from "../audits/auditIssueImageRecords";
import { uploadAuditIssueImage } from "../audits/auditIssueImageUploads";
import type { ApiEnv } from "../auth/apiEnv";
import type { IssueContext } from "../issues/issueRecords";
import { activityBatch } from "../shared/activity";
import { readBody, respond } from "../shared/respond";
import { offlineWrites } from "./offlineRecords";
import { readOfflineSync } from "./offlineSync";

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

offline.get("/sync", async (context) => {
  const query = OfflineSyncQuerySchema.safeParse(context.req.query());
  if (!query.success || !matchesScope(context, query.data))
    return context.json(
      {
        error:
          "The active account or organization changed. Reload before syncing.",
      },
      403,
    );
  return respond(
    context,
    offlineRoutes.sync,
    await readOfflineSync(
      context.env.DB,
      query.data.organizationId,
      query.data.userId,
      query.data.after,
    ),
  );
});

offline.post("/operations", async (context) => {
  const parsed = await readBody(
    context,
    offlineRoutes.apply,
    "Invalid offline operation.",
  );
  if (parsed instanceof Response) return parsed;
  const { operation, ...scope } = parsed;
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
  const resourceId =
    operation.type === "auditSave" ? operation.auditId : operation.id;
  // A second tab, or a retry after a lost response, may commit this very
  // operation at any point; its receipt answers before any refusal does.
  const replayed = async () => {
    const committed = await receipt();
    return committed && replay(context, resourceId, digest, committed.digest);
  };
  const refuse = async (error: string) =>
    (await replayed()) ?? context.json({ error }, 409);
  const existing = await replayed();
  if (existing) return existing;
  const writes = await offlineWrites(context, operation);
  if (typeof writes === "string") return refuse(writes);
  try {
    // The receipt comes last, written only on the condition that proves the
    // writes before it applied, so a skipped write commits nothing.
    const results = await activityBatch(context.env.DB, context.get("apiKey"), [
      ...writes.statements,
      context.env.DB.prepare(
        `INSERT INTO offline_operations (organization_id, user_id, id, digest, created_at)
         SELECT ?, ?, ?, ?, ? WHERE ${writes.applied.sql}`,
      ).bind(
        scope.organizationId,
        scope.userId,
        operation.id,
        digest,
        new Date().toISOString(),
        ...writes.applied.bindings,
      ),
    ]);
    if (!Number(results.at(-1)?.meta.changes)) return refuse(writes.rejected);
  } catch (cause) {
    const committed = await replayed();
    if (committed) return committed;
    const validation = await offlineWrites(context, operation);
    if (typeof validation === "string") return refuse(validation);
    throw cause;
  }
  return respond(context, offlineRoutes.apply, { resourceId }, 201);
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
