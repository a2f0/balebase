import { Hono } from "hono";
import { findAuditIssueImage } from "./auditIssueImageRecords";
import { uploadAuditIssueImage } from "./auditIssueImageUploads";
import type { ApiEnv } from "./authMiddleware";
import { contentDisposition, downloadResponse } from "./shared/storage";

const auditIssueImages = new Hono<ApiEnv>();

auditIssueImages.post("/:issueId/images", (context) =>
  uploadAuditIssueImage(context),
);

auditIssueImages.get("/:issueId/images/:imageId", async (context) => {
  const row = await findAuditIssueImage(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("issueId"),
    context.req.param("imageId"),
  );
  if (!row) return context.json({ error: "Issue image not found." }, 404);
  const object = await context.env.STORAGE.get(row.object_key);
  if (!object) {
    return context.json({ error: "Issue image data not found." }, 404);
  }
  if (context.req.query("variant") === "thumbnail") {
    try {
      const thumbnail = await context.env.IMAGES.input(object.body)
        .transform({ fit: "scale-down", height: 480, width: 480 })
        .output({ anim: false, format: "image/webp", quality: 80 });
      const response = thumbnail.response();
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      headers.set(
        "content-disposition",
        contentDisposition({
          disposition: "inline",
          fallbackFilename: "thumbnail.webp",
        }),
      );
      headers.set("x-content-type-options", "nosniff");
      return new Response(response.body, { headers, status: response.status });
    } catch (cause) {
      console.error("Audit issue thumbnail generation failed.", cause);
      return context.json(
        { error: "Issue thumbnail could not be generated." },
        502,
      );
    }
  }
  return downloadResponse(object, {
    disposition: "inline",
    fallbackFilename: "image",
    filename: row.filename,
    headers: {
      "cache-control": "no-store",
      "content-length": String(row.size),
      "content-type": row.content_type,
    },
  });
});

export { auditIssueImages };
