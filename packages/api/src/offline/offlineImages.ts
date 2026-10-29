import type { AuditIssueImage } from "@balebase/validators/audits";
import { offlineRoutes } from "@balebase/validators/offline";
import {
  findAuditIssueImage,
  toAuditIssueImage,
} from "../audits/auditIssueImageRecords";
import type { IssueContext } from "../issues/issueRecords";
import { respond } from "../shared/respond";

export async function replayOfflineImage(
  context: IssueContext,
  organizationId: string,
  issueId: string,
  imageId: string,
) {
  const receipt = await context.env.DB.prepare(
    "SELECT issue_id, image FROM offline_image_receipts WHERE organization_id = ? AND user_id = ? AND id = ?",
  )
    .bind(organizationId, context.get("authSession").user.id, imageId)
    .first<{ issue_id: string; image: string }>();
  if (receipt) {
    return receipt.issue_id === issueId
      ? respond(context, offlineRoutes.uploadImage, {
          image: JSON.parse(receipt.image) as AuditIssueImage,
        })
      : context.json(
          { error: "This image ID was already used for a different issue." },
          409,
        );
  }
  const existing = await findAuditIssueImage(
    context.env.DB,
    organizationId,
    issueId,
    imageId,
    true,
  );
  if (!existing) return undefined;
  if (existing.uploaded_by_id !== context.get("authSession").user.id) {
    return context.json(
      { error: "This image belongs to a different uploader." },
      409,
    );
  }
  if (existing.deletion_pending) {
    context.header("retry-after", "30");
    return context.json(
      {
        error:
          "The previous image upload is still being finalized. Retry shortly.",
      },
      429,
    );
  }
  return respond(context, offlineRoutes.uploadImage, {
    image: toAuditIssueImage(existing),
  });
}
