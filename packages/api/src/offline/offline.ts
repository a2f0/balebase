import {
  type OfflineOperation,
  type OfflineScope,
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
import {
  type OfflineWrites,
  offlineWrites,
  readAuditState,
} from "./offlineRecords";
import { readOfflineSync } from "./offlineSync";

export const offline = new Hono<ApiEnv>();

/** How many times a device's merge runs before the device retries later. */
const mergeAttempts = 3;

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

offline.get("/audits/:auditId", async (context) => {
  const scope = OfflineScopeSchema.safeParse(context.req.query());
  if (!scope.success || !matchesScope(context, scope.data))
    return context.json(
      {
        error:
          "The active account or organization changed. Reload before syncing.",
      },
      403,
    );
  const state = await readAuditState(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("auditId"),
  );
  return state
    ? respond(context, offlineRoutes.audit, state)
    : context.json({ error: "Audit not found." }, 404);
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
  const request = { context, digest, operation, scope };
  const replies = operationReplies(request);
  return (await replies.replayed()) ?? applyOperation(request, replies);
});

/** An operation a device sent, with the digest its receipt keeps. */
interface OperationRequest {
  context: IssueContext;
  digest: string;
  operation: OfflineOperation;
  scope: OfflineScope;
}

/** The answers to one operation; see `operationReplies`. */
interface OperationReplies {
  applied: (status: 200 | 201) => Promise<Response>;
  refuse: (error: string) => Promise<Response>;
  replayed: () => Promise<Response | null>;
}

/**
 * The answers to an operation. An audit write answers with the audit as the
 * server now has it, so the device takes what others changed along with the
 * result of its own. A second tab, or a retry after a lost response, may
 * commit this very operation at any point; its receipt answers before any
 * refusal does.
 */
function operationReplies({
  context,
  digest,
  operation,
  scope,
}: OperationRequest): OperationReplies {
  const auditId =
    operation.type === "auditSave"
      ? operation.auditId
      : operation.type === "auditStart"
        ? operation.id
        : undefined;
  const applied = async (status: 200 | 201) => {
    const audit = auditId
      ? await readAuditState(
          context.env.DB,
          context.get("organizationId"),
          auditId,
        )
      : null;
    return respond(
      context,
      offlineRoutes.apply,
      { resourceId: auditId ?? operation.id, ...(audit ? { audit } : {}) },
      status,
    );
  };
  const replayed = async () => {
    const committed = await context.env.DB.prepare(
      "SELECT digest FROM offline_operations WHERE organization_id = ? AND user_id = ? AND id = ?",
    )
      .bind(scope.organizationId, scope.userId, operation.id)
      .first<{ digest: string }>();
    if (!committed) return null;
    return committed.digest === digest
      ? applied(200)
      : context.json(
          {
            error:
              "This offline operation was already synced with different content.",
          },
          409,
        );
  };
  const refuse = async (error: string) =>
    (await replayed()) ?? context.json({ error }, 409);
  return { applied, refuse, replayed };
}

/**
 * Applies the operation. A merge whose audit moved on since its read merges
 * again over the newer copy, a few times before leaving it to the device's
 * next sync.
 */
async function applyOperation(
  request: OperationRequest,
  replies: OperationReplies,
) {
  for (let attempt = 1; ; attempt += 1) {
    const writes = await offlineWrites(request.context, request.operation);
    if (typeof writes === "string") return replies.refuse(writes);
    try {
      if (await commitWrites(request, writes)) return replies.applied(201);
    } catch (cause) {
      const committed = await replies.replayed();
      if (committed) return committed;
      const validation = await offlineWrites(
        request.context,
        request.operation,
      );
      if (typeof validation === "string") return replies.refuse(validation);
      throw cause;
    }
    if (!writes.retry) return replies.refuse(writes.rejected);
    const committed = await replies.replayed();
    if (committed) return committed;
    if (attempt === mergeAttempts)
      return request.context.json({ error: writes.rejected }, 503);
  }
}

/**
 * Commits the writes with the operation's receipt, which comes last and is
 * written only on the condition that proves the writes before it applied,
 * so a skipped write commits nothing. Resolves whether they applied.
 */
async function commitWrites(
  { context, digest, operation, scope }: OperationRequest,
  writes: OfflineWrites,
) {
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
  return Boolean(Number(results.at(-1)?.meta.changes));
}

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
