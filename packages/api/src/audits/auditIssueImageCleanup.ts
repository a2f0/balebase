import { auditIssueImageUploadGraceMilliseconds } from "../library/objectLifecycle";
import type { Bindings } from "../types";

const pendingCleanupBatchSize = 100;

interface PendingAuditIssueObject {
  id: string;
}

export async function deletePendingAuditIssueObject(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  object: PendingAuditIssueObject,
  abandonedClaimCutoff = new Date(
    Date.now() - auditIssueImageUploadGraceMilliseconds,
  ).toISOString(),
  uploadLeaseCutoff = new Date().toISOString(),
) {
  const cleanupToken = crypto.randomUUID();
  const claimedAt = new Date().toISOString();
  const claimed = await environment.DB.prepare(
    `UPDATE objects
     SET cleanup_token = ?, cleanup_claimed_at = ?, upload_token = NULL,
         upload_lease_expires_at = NULL
     WHERE id = ? AND kind = 'audit_issue_image' AND deletion_pending = 1
       AND (cleanup_token IS NULL OR datetime(cleanup_claimed_at) <= datetime(?))
       AND (
         upload_token IS NULL OR (
           upload_lease_expires_at IS NOT NULL
           AND datetime(upload_lease_expires_at) <= datetime(?)
         )
       )
     RETURNING object_key`,
  )
    .bind(
      cleanupToken,
      claimedAt,
      object.id,
      abandonedClaimCutoff,
      uploadLeaseCutoff,
    )
    .first<{ object_key: string }>();
  if (!claimed) return false;
  await environment.STORAGE.delete(claimed.object_key);
  await environment.DB.batch([
    environment.DB.prepare(
      `DELETE FROM audit_issue_images
       WHERE object_id = ? AND EXISTS (
         SELECT 1 FROM objects
         WHERE id = ? AND kind = 'audit_issue_image'
           AND deletion_pending = 1 AND cleanup_token = ?
       )`,
    ).bind(object.id, object.id, cleanupToken),
    environment.DB.prepare(
      `DELETE FROM objects
       WHERE id = ? AND kind = 'audit_issue_image' AND deletion_pending = 1
         AND cleanup_token = ?`,
    ).bind(object.id, cleanupToken),
  ]);
  return true;
}

export async function attemptPendingObjectCleanup(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  id: string,
) {
  try {
    await deletePendingAuditIssueObject(environment, { id });
  } catch (cause) {
    // The D1 tombstone intentionally remains for the scheduled retry.
    console.error("Audit issue image cleanup deferred.", cause);
  }
}

/** Retry durable R2 cleanup tombstones without racing an in-flight upload. */
export async function purgePendingAuditIssueImages(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  cutoff = new Date(
    Date.now() - auditIssueImageUploadGraceMilliseconds,
  ).toISOString(),
  uploadLeaseCutoff = new Date().toISOString(),
) {
  const result = await environment.DB.prepare(
    `SELECT id FROM objects
     WHERE kind = 'audit_issue_image' AND deletion_pending = 1
       AND datetime(created_at) <= datetime(?)
       AND (cleanup_token IS NULL OR datetime(cleanup_claimed_at) <= datetime(?))
       AND (
         upload_token IS NULL OR (
           upload_lease_expires_at IS NOT NULL
           AND datetime(upload_lease_expires_at) <= datetime(?)
         )
       )
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
  )
    .bind(cutoff, cutoff, uploadLeaseCutoff, pendingCleanupBatchSize)
    .all<PendingAuditIssueObject>();
  let firstFailure: unknown;
  let purged = 0;
  for (const object of result.results) {
    try {
      const deleted = await deletePendingAuditIssueObject(
        environment,
        object,
        cutoff,
        uploadLeaseCutoff,
      );
      if (deleted) purged += 1;
    } catch (cause) {
      firstFailure ??= cause;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
  return purged;
}
