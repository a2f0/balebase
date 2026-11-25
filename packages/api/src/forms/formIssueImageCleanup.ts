import { formIssueImageUploadGraceMilliseconds } from "../library/objectLifecycle";
import type { Bindings } from "../types";

const pendingCleanupBatchSize = 100;

interface PendingFormIssueObject {
  id: string;
}

export async function deletePendingFormIssueObject(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  object: PendingFormIssueObject,
  abandonedClaimCutoff = new Date(
    Date.now() - formIssueImageUploadGraceMilliseconds,
  ).toISOString(),
  uploadLeaseCutoff = new Date().toISOString(),
) {
  const cleanupToken = crypto.randomUUID();
  const claimedAt = new Date().toISOString();
  const claimed = await environment.DB.prepare(
    `UPDATE objects
     SET cleanup_token = ?, cleanup_claimed_at = ?, upload_token = NULL,
         upload_lease_expires_at = NULL
     WHERE id = ? AND kind = 'form_issue_image' AND deletion_pending = 1
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
      `DELETE FROM form_issue_images
       WHERE object_id = ? AND EXISTS (
         SELECT 1 FROM objects
         WHERE id = ? AND kind = 'form_issue_image'
           AND deletion_pending = 1 AND cleanup_token = ?
       )`,
    ).bind(object.id, object.id, cleanupToken),
    environment.DB.prepare(
      `DELETE FROM objects
       WHERE id = ? AND kind = 'form_issue_image' AND deletion_pending = 1
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
    await deletePendingFormIssueObject(environment, { id });
  } catch (cause) {
    // The D1 tombstone intentionally remains for the scheduled retry.
    console.error("Form issue image cleanup deferred.", cause);
  }
}

/** Abandoned uploads no live cleanup or upload holds; binds cutoff twice, then the lease cutoff. */
const pendingImages = `FROM objects
  WHERE kind = 'form_issue_image' AND deletion_pending = 1
    AND datetime(created_at) <= datetime(?)
    AND (cleanup_token IS NULL OR datetime(cleanup_claimed_at) <= datetime(?))
    AND (
      upload_token IS NULL OR (
        upload_lease_expires_at IS NOT NULL
        AND datetime(upload_lease_expires_at) <= datetime(?)
      )
    )`;

/** What `purgePendingFormIssueImages` would delete now; it changes nothing. */
export async function previewPendingFormIssueImagePurge(
  environment: Pick<Bindings, "DB">,
  cutoff = new Date(
    Date.now() - formIssueImageUploadGraceMilliseconds,
  ).toISOString(),
  uploadLeaseCutoff = new Date().toISOString(),
) {
  const row = await environment.DB.prepare(
    `SELECT count(*) AS eligible ${pendingImages}`,
  )
    .bind(cutoff, cutoff, uploadLeaseCutoff)
    .first<{ eligible: number }>();
  const eligible = row?.eligible ?? 0;
  return { eligible, wouldPurge: Math.min(eligible, pendingCleanupBatchSize) };
}

/** Retry durable R2 cleanup tombstones without racing an in-flight upload. */
export async function purgePendingFormIssueImages(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  cutoff = new Date(
    Date.now() - formIssueImageUploadGraceMilliseconds,
  ).toISOString(),
  uploadLeaseCutoff = new Date().toISOString(),
) {
  const result = await environment.DB.prepare(
    `SELECT id ${pendingImages}
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
  )
    .bind(cutoff, cutoff, uploadLeaseCutoff, pendingCleanupBatchSize)
    .all<PendingFormIssueObject>();
  let firstFailure: unknown;
  let purged = 0;
  for (const object of result.results) {
    try {
      const deleted = await deletePendingFormIssueObject(
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
