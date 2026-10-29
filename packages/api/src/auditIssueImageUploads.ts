import { auditsRoutes } from "@balebase/validators/audits";
import {
  maxIssueImageBytes,
  maxIssueImages,
} from "@balebase/validators/issueRules";
import { offlineRoutes } from "@balebase/validators/offline";
import type { Context } from "hono";
import { attemptPendingObjectCleanup } from "./auditIssueImageCleanup";
import {
  maxImageReadMilliseconds,
  normalizedImageFilename,
  parseImageUpload,
  validateImage,
} from "./auditIssueImageNormalization";
import {
  findAuditIssueImage,
  toAuditIssueImage,
} from "./auditIssueImageRecords";
import {
  discardedAuditError,
  issueAuditDiscarded,
  issueAuditNotDiscarded,
} from "./auditRunRecords";
import type { ApiKeyPrincipal } from "./auth/apiKeys";
import type { ApiEnv } from "./auth/authMiddleware";
import { auditIssueImageUploadGraceMilliseconds } from "./objectLifecycle";
import { replayOfflineImage } from "./offlineImages";
import { activityBatch } from "./shared/activity";
import { normalizeFilename } from "./shared/filenames";
import { respond } from "./shared/respond";
import { BodyReadTimeoutError, readBodyWithLimit } from "./shared/storage";
import type { Bindings } from "./types";

type AuditIssueImageContext = Context<ApiEnv>;

// A maximum-size request can briefly retain its 10 MB input buffer, the
// immutable Blob consumed by Images, and a 10 MB normalized R2 body. Keep two
// such pipelines well below Workers' shared 128 MB isolate memory limit.
const maxConcurrentImageUploads = 2;
const maxConcurrentImageUploadsPerOrganization = 1;
let activeImageUploads = 0;
const activeOrganizationImageUploads = new Map<string, number>();

function acquireImageUploadCapacity(organizationId: string) {
  const organizationUploads =
    activeOrganizationImageUploads.get(organizationId) ?? 0;
  if (
    activeImageUploads >= maxConcurrentImageUploads ||
    organizationUploads >= maxConcurrentImageUploadsPerOrganization
  ) {
    return null;
  }
  activeImageUploads += 1;
  activeOrganizationImageUploads.set(organizationId, organizationUploads + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeImageUploads -= 1;
    const remaining =
      (activeOrganizationImageUploads.get(organizationId) ?? 1) - 1;
    if (remaining === 0) activeOrganizationImageUploads.delete(organizationId);
    else activeOrganizationImageUploads.set(organizationId, remaining);
  };
}

export async function uploadAuditIssueImage(
  context: AuditIssueImageContext,
  imageId?: string,
) {
  const organizationId = context.get("organizationId");
  const issueId = context.req.param("issueId") ?? "";
  if (
    imageId &&
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(imageId)
  )
    return context.json({ error: "Invalid image ID." }, 400);
  if (imageId) {
    const replay = await replayOfflineImage(
      context,
      organizationId,
      issueId,
      imageId,
    );
    if (replay) return replay;
  }
  const issue = await context.env.DB.prepare(
    `SELECT issue.id, audit.deleted_at AS audit_deleted_at
     FROM issues AS issue
     LEFT JOIN audits AS audit ON audit.id = issue.target_id AND issue.target_type = 'audit_run'
     WHERE issue.id = ? AND issue.organization_id = ? AND issue.target_type IN ('audit_run', 'workspace')`,
  )
    .bind(issueId, organizationId)
    .first<{ audit_deleted_at: string | null; id: string }>();
  if (!issue) return context.json({ error: "Issue not found." }, 404);
  if (issue.audit_deleted_at) {
    return context.json({ error: discardedAuditError }, 409);
  }

  const releaseCapacity = acquireImageUploadCapacity(organizationId);
  if (releaseCapacity === null) {
    context.header("retry-after", "1");
    return context.json(
      { error: "Image uploads are busy. Please retry in a moment." },
      429,
    );
  }
  try {
    const reservation = await reserveAuditIssueImage(
      context.env.DB,
      organizationId,
      issue.id,
      context.get("authSession").user.id,
      context.req.query("filename"),
      imageId,
    );
    if (reservation === null) {
      const discarded = await issueAuditDiscarded(
        context.env.DB,
        organizationId,
        issue.id,
      );
      return context.json(
        {
          error: discarded
            ? discardedAuditError
            : `Issues are limited to ${maxIssueImages} images.`,
        },
        409,
      );
    }
    return await uploadReservedAuditIssueImage(
      context,
      organizationId,
      issue.id,
      reservation,
    );
  } finally {
    releaseCapacity();
  }
}

async function uploadReservedAuditIssueImage(
  context: AuditIssueImageContext,
  organizationId: string,
  issueId: string,
  reservation: AuditIssueImageReservation,
) {
  let upload: Awaited<ReturnType<typeof parseImageUpload>> | undefined;
  let validation: Awaited<ReturnType<typeof validateImage>>;
  let requestedFilename: string;
  try {
    upload = await parseImageUpload(
      context.req.raw,
      context.req.query("filename"),
    );
    if ("error" in upload) {
      await discardAuditIssueImageReservation(
        context.env.DB,
        reservation.objectId,
        reservation.uploadToken,
      );
      return context.json({ error: upload.error }, upload.status);
    }
    requestedFilename = upload.filename;
    validation = await validateImage(context.env.IMAGES, upload.bytes);
    upload = undefined;
    if ("error" in validation) {
      await discardAuditIssueImageReservation(
        context.env.DB,
        reservation.objectId,
        reservation.uploadToken,
      );
      return context.json({ error: validation.error }, validation.status);
    }
  } catch (cause) {
    await discardAuditIssueImageReservation(
      context.env.DB,
      reservation.objectId,
      reservation.uploadToken,
    );
    throw cause;
  }
  const { imageType, stream } = validation;
  const filename = normalizedImageFilename(
    requestedFilename,
    imageType.extension,
  );
  try {
    await persistAuditIssueImage(
      context.env,
      stream,
      {
        contentType: imageType.contentType,
        filename,
        issueId,
        objectId: reservation.objectId,
        objectKey: reservation.objectKey,
        organizationId,
        uploadToken: reservation.uploadToken,
      },
      context.get("apiKey"),
    );
  } catch (cause) {
    if (cause instanceof AuditIssueImageUploadError) {
      return context.json({ error: cause.message }, cause.status);
    }
    throw cause;
  }
  const image = await findAuditIssueImage(
    context.env.DB,
    organizationId,
    issueId,
    reservation.imageId,
  );
  if (!image) throw new Error("Uploaded issue image could not be loaded.");
  return respond(
    context,
    context.req.method === "PUT"
      ? offlineRoutes.uploadImage
      : auditsRoutes.uploadIssueImage,
    { image: toAuditIssueImage(image) },
    201,
  );
}

interface AuditIssueImageInsert {
  contentType: string;
  filename: string;
  issueId: string;
  objectId: string;
  objectKey: string;
  organizationId: string;
  uploadToken: string;
}

interface AuditIssueImageReservation {
  imageId: string;
  objectId: string;
  objectKey: string;
  uploadToken: string;
}

async function reserveAuditIssueImage(
  database: D1Database,
  organizationId: string,
  issueId: string,
  userId: string,
  requestedFilename: string | undefined,
  requestedImageId?: string,
): Promise<AuditIssueImageReservation | null> {
  const createdAt = new Date().toISOString();
  const imageId = requestedImageId ?? crypto.randomUUID();
  const objectId = crypto.randomUUID();
  const uploadToken = crypto.randomUUID();
  const uploadLeaseExpiresAt = new Date(
    Date.now() + auditIssueImageUploadGraceMilliseconds,
  ).toISOString();
  const objectKey = `organizations/${organizationId}/audit-issues/${issueId}/${objectId}/image`;
  const filename = normalizeFilename(requestedFilename ?? "", "issue-image");
  await database
    .prepare(
      `INSERT INTO objects
       (id, organization_id, object_key, filename, content_type, size,
        created_at, kind, deletion_pending, upload_token,
        upload_lease_expires_at)
       VALUES (?, ?, ?, ?, 'application/octet-stream', 0, ?,
               'audit_issue_image', 1, ?, ?)`,
    )
    .bind(
      objectId,
      organizationId,
      objectKey,
      filename,
      createdAt,
      uploadToken,
      uploadLeaseExpiresAt,
    )
    .run();
  let reserved: { id: string } | null;
  try {
    reserved = await database
      .prepare(
        `WITH RECURSIVE slots(slot) AS (
           VALUES (1)
           UNION ALL
           SELECT slot + 1 FROM slots WHERE slot < ?
         )
         INSERT INTO audit_issue_images
         (id, issue_id, object_id, uploaded_by, created_at, slot)
         SELECT ?, ?, ?, ?, ?, slots.slot
         FROM slots
         WHERE NOT EXISTS (
           SELECT 1 FROM audit_issue_images AS existing
           WHERE existing.issue_id = ? AND existing.slot = slots.slot
         ) AND ${issueAuditNotDiscarded}
         ORDER BY slots.slot ASC
         LIMIT 1
         RETURNING id`,
      )
      .bind(
        maxIssueImages,
        imageId,
        issueId,
        objectId,
        userId,
        createdAt,
        issueId,
        issueId,
      )
      .first<{ id: string }>();
  } catch (cause) {
    await discardAuditIssueImageReservation(database, objectId, uploadToken);
    throw cause;
  }
  if (reserved === null) {
    await discardAuditIssueImageReservation(database, objectId, uploadToken);
    return null;
  }
  return { imageId, objectId, objectKey, uploadToken };
}

async function discardAuditIssueImageReservation(
  database: D1Database,
  objectId: string,
  uploadToken: string,
) {
  await database.batch([
    database
      .prepare(
        `DELETE FROM audit_issue_images
         WHERE object_id = ? AND EXISTS (
           SELECT 1 FROM objects
           WHERE id = ? AND kind = 'audit_issue_image'
             AND deletion_pending = 1 AND cleanup_token IS NULL
             AND upload_token = ?
         )`,
      )
      .bind(objectId, objectId, uploadToken),
    database
      .prepare(
        `DELETE FROM objects
         WHERE id = ? AND kind = 'audit_issue_image'
           AND deletion_pending = 1 AND cleanup_token IS NULL
           AND upload_token = ?`,
      )
      .bind(objectId, uploadToken),
  ]);
}

class AuditIssueImageUploadError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 408 | 409 | 413,
  ) {
    super(message);
  }
}

async function abandonAuditIssueImageUpload(
  database: D1Database,
  objectId: string,
  uploadToken: string,
) {
  await database
    .prepare(
      `UPDATE objects
       SET upload_token = NULL, upload_lease_expires_at = NULL
       WHERE id = ? AND kind = 'audit_issue_image'
         AND deletion_pending = 1 AND upload_token = ?`,
    )
    .bind(objectId, uploadToken)
    .run();
}

async function persistAuditIssueImage(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  stream: ReadableStream<Uint8Array>,
  image: AuditIssueImageInsert,
  apiKey: ApiKeyPrincipal | undefined,
) {
  await refreshAuditIssueImageUploadLease(environment.DB, image);
  const normalizedSize = await writeNormalizedAuditIssueImage(
    environment,
    stream,
    image,
  );
  try {
    const activation = environment.DB.prepare(
      `UPDATE objects
       SET size = ?, deletion_pending = 0, upload_token = NULL,
           upload_lease_expires_at = NULL
       WHERE id = ? AND kind = 'audit_issue_image'
         AND deletion_pending = 1 AND cleanup_token IS NULL
         AND upload_token = ?
         AND EXISTS (
           SELECT 1 FROM audit_issue_images AS reservation
           WHERE reservation.object_id = objects.id
             AND reservation.issue_id = ?
         )
         AND ${issueAuditNotDiscarded}`,
    ).bind(
      normalizedSize,
      image.objectId,
      image.uploadToken,
      image.issueId,
      image.issueId,
    );
    // Activation records the upload's activity.
    const [activated] = await activityBatch(environment.DB, apiKey, [
      activation,
    ]);
    if (Number(activated?.meta.changes) === 0) {
      throw new Error("Issue image reservation could not be activated.");
    }
  } catch (cause) {
    const activationCommitted = await recoverFailedAuditIssueImageActivation(
      environment,
      image,
      normalizedSize,
    );
    if (activationCommitted) return;
    // A discard during the upload leaves the bytes to the cleanup above.
    if (
      await issueAuditDiscarded(
        environment.DB,
        image.organizationId,
        image.issueId,
      )
    ) {
      throw new AuditIssueImageUploadError(discardedAuditError, 409);
    }
    throw cause;
  }
}

interface AuditIssueImageActivationState {
  deletion_pending: number;
  object_key: string;
  reservation_exists: number;
}

type ActivationStateRead =
  | { known: true; state: AuditIssueImageActivationState | null }
  | { known: false };

async function readAuditIssueImageActivationState(
  database: D1Database,
  image: AuditIssueImageInsert,
): Promise<ActivationStateRead> {
  try {
    const state = await database
      .prepare(
        `SELECT object_key, deletion_pending,
                EXISTS (
                  SELECT 1 FROM audit_issue_images
                  WHERE object_id = objects.id AND issue_id = ?
                ) AS reservation_exists
         FROM objects
         WHERE id = ? AND organization_id = ? AND kind = 'audit_issue_image'`,
      )
      .bind(image.issueId, image.objectId, image.organizationId)
      .first<AuditIssueImageActivationState>();
    return { known: true, state };
  } catch {
    return { known: false };
  }
}

function isCommittedAuditIssueImageActivation(
  read: ActivationStateRead,
  image: AuditIssueImageInsert,
) {
  return (
    read.known &&
    read.state?.deletion_pending === 0 &&
    read.state.object_key === image.objectKey &&
    read.state.reservation_exists === 1
  );
}

async function recoverFailedAuditIssueImageActivation(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  image: AuditIssueImageInsert,
  size: number,
) {
  const initialState = await readAuditIssueImageActivationState(
    environment.DB,
    image,
  );
  if (isCommittedAuditIssueImageActivation(initialState, image)) return true;
  // A failed state read makes the activation result ambiguous. Retain R2 bytes
  // so a committed image can never be turned into an active dangling row.
  if (!initialState.known) return false;

  try {
    await restoreAuditIssueImageCleanupTombstone(environment.DB, image, size);
  } catch (tombstoneCause) {
    const latestState = await readAuditIssueImageActivationState(
      environment.DB,
      image,
    );
    if (isCommittedAuditIssueImageActivation(latestState, image)) return true;
    // Delete only after an authoritative read proves the object is absent or
    // still pending. Unknown or unexpectedly active state retains the bytes.
    if (!latestState.known || latestState.state?.deletion_pending === 0) {
      return false;
    }
    try {
      await environment.STORAGE.delete(image.objectKey);
      return false;
    } catch (deleteCause) {
      throw new AggregateError(
        [tombstoneCause, deleteCause],
        "Issue image activation and cleanup recovery both failed.",
      );
    }
  }
  const restoredState = await readAuditIssueImageActivationState(
    environment.DB,
    image,
  );
  if (isCommittedAuditIssueImageActivation(restoredState, image)) return true;
  await attemptPendingObjectCleanup(environment, image.objectId);
  return false;
}

async function restoreAuditIssueImageCleanupTombstone(
  database: D1Database,
  image: AuditIssueImageInsert,
  size: number,
) {
  await database
    .prepare(
      `INSERT INTO objects
       (id, organization_id, object_key, filename, content_type, size,
        created_at, kind, deletion_pending, cleanup_token,
        cleanup_claimed_at, upload_token, upload_lease_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'audit_issue_image', 1,
               NULL, NULL, NULL, NULL)
       ON CONFLICT(id) DO UPDATE SET
         organization_id = excluded.organization_id,
         object_key = excluded.object_key,
         filename = excluded.filename,
         content_type = excluded.content_type,
         size = excluded.size,
         deletion_pending = 1,
         cleanup_token = NULL,
         cleanup_claimed_at = NULL,
         upload_token = NULL,
         upload_lease_expires_at = NULL
       WHERE objects.kind = 'audit_issue_image'
         AND objects.deletion_pending = 1`,
    )
    .bind(
      image.objectId,
      image.organizationId,
      image.objectKey,
      image.filename,
      image.contentType,
      size,
      new Date().toISOString(),
    )
    .run();
}

async function refreshAuditIssueImageUploadLease(
  database: D1Database,
  image: AuditIssueImageInsert,
) {
  // The pending object and image row already reserve a unique per-issue slot.
  // Fill in the validated metadata before writing bytes so any later failure
  // leaves a complete durable cleanup tombstone.
  try {
    const metadata = await database
      .prepare(
        `UPDATE objects
       SET filename = ?, content_type = ?, upload_lease_expires_at = ?
       WHERE id = ? AND organization_id = ? AND kind = 'audit_issue_image'
         AND deletion_pending = 1 AND cleanup_token IS NULL
         AND upload_token = ?`,
      )
      .bind(
        image.filename,
        image.contentType,
        new Date(
          Date.now() + auditIssueImageUploadGraceMilliseconds,
        ).toISOString(),
        image.objectId,
        image.organizationId,
        image.uploadToken,
      )
      .run();
    if (!Number(metadata.meta.changes)) {
      throw new Error("Issue image reservation is no longer available.");
    }
  } catch (cause) {
    await discardAuditIssueImageReservation(
      database,
      image.objectId,
      image.uploadToken,
    );
    throw cause;
  }
}

async function abandonAndCleanupAuditIssueImage(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  image: AuditIssueImageInsert,
) {
  await abandonAuditIssueImageUpload(
    environment.DB,
    image.objectId,
    image.uploadToken,
  );
  await attemptPendingObjectCleanup(environment, image.objectId);
}

async function writeNormalizedAuditIssueImage(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  stream: ReadableStream<Uint8Array>,
  image: AuditIssueImageInsert,
) {
  let normalizedBytes: Uint8Array | null;
  try {
    normalizedBytes = await readBodyWithLimit(
      stream,
      maxIssueImageBytes,
      maxImageReadMilliseconds,
    );
  } catch (cause) {
    await abandonAndCleanupAuditIssueImage(environment, image);
    if (cause instanceof BodyReadTimeoutError) {
      throw new AuditIssueImageUploadError(
        "Image processing must finish within 60 seconds.",
        408,
      );
    }
    throw cause;
  }
  if (normalizedBytes === null) {
    await abandonAndCleanupAuditIssueImage(environment, image);
    throw new AuditIssueImageUploadError(
      "Normalized images must be 10 MB or smaller.",
      413,
    );
  }
  if (normalizedBytes.byteLength === 0) {
    await abandonAndCleanupAuditIssueImage(environment, image);
    throw new AuditIssueImageUploadError(
      "The uploaded image could not be normalized safely.",
      400,
    );
  }
  try {
    // R2 requires a body with a known length. A Uint8Array preserves the
    // bounded byte length; a generic TransformStream is rejected by workerd.
    await environment.STORAGE.put(image.objectKey, normalizedBytes, {
      httpMetadata: { contentType: image.contentType },
      customMetadata: {
        filename: image.filename,
        issueId: image.issueId,
        organizationId: image.organizationId,
      },
    });
  } catch (cause) {
    await abandonAndCleanupAuditIssueImage(environment, image);
    throw cause;
  }
  return normalizedBytes.byteLength;
}
