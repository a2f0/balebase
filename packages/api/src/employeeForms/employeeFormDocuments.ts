import { employeeFormsRoutes } from "@balebase/validators/employeeForms";
import { Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { canManage } from "../organizations/organizationMembers";
import { normalizeFilename } from "../shared/filenames";
import { respond } from "../shared/respond";
import {
  readBoundedForm,
  storedDownload,
  trackedPut,
  uploadStillQueued,
} from "../shared/storage";
import { canAccessRequirement, findRequirement } from "./employeeFormRecords";

/** Uploading and downloading the document a form requirement asks for. */
export const employeeFormDocuments = new Hono<ApiEnv>();
const maxDocumentBytes = 10 * 1024 * 1024;
const documentTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);

employeeFormDocuments.post("/:id/document", async (context) => {
  const row = await findRequirement(context);
  if (!row || !(await canAccessRequirement(context, row))) {
    return context.json({ error: "Requirement not found." }, 404);
  }
  if (row.kind !== "form") {
    return context.json({ error: "Only forms accept documents." }, 400);
  }
  const form = await readBoundedForm(context.req.raw, maxDocumentBytes);
  if (form === "too_large") {
    return context.json({ error: "Files must be 10 MB or smaller." }, 413);
  }
  const file = form?.get("file");
  if (!(file instanceof File) || !documentTypes.has(file.type)) {
    return context.json({ error: "Choose a PDF, JPEG, or PNG file." }, 400);
  }
  if (!file.size || file.size > maxDocumentBytes) {
    return context.json({ error: "Files must be 10 MB or smaller." }, 413);
  }
  const key = `organizations/${context.get("organizationId")}/employee-forms/${row.id}/${crypto.randomUUID()}`;
  const filename = normalizeFilename(file.name, "form", 200);
  try {
    await trackedPut(
      context.env,
      {
        cleanupId: `employee-form-upload:${crypto.randomUUID()}`,
        key,
        organizationId: context.get("organizationId"),
      },
      file,
      { httpMetadata: { contentType: file.type } },
    );
    const updated = await context.env.DB.prepare(
      `UPDATE employee_requirements
       SET document_key = ?, document_filename = ?, document_size = ?,
           document_revision = document_revision + 1,
           status = 'submitted', completed_at = NULL, updated_at = ?
       WHERE id = ? AND organization_id = ? AND document_key IS ?
         AND ${uploadStillQueued}
         AND (? = 1 OR EXISTS (
           SELECT 1 FROM member WHERE member.id = employee_requirements.member_id
             AND member.organizationId = ? AND member.userId = ?
         ))`,
    )
      .bind(
        key,
        filename,
        file.size,
        new Date().toISOString(),
        row.id,
        context.get("organizationId"),
        row.document_key,
        key,
        canManage(context) ? 1 : 0,
        context.get("organizationId"),
        context.get("authSession").user.id,
      )
      .run();
    if (!updated.meta.changes) {
      await context.env.STORAGE.delete(key).catch(console.error);
      return context.json(
        { error: "The form changed. Please try again." },
        409,
      );
    }
  } catch (cause) {
    const linked = await context.env.DB.prepare(
      `SELECT document_key FROM employee_requirements
       WHERE id = ? AND organization_id = ?`,
    )
      .bind(row.id, context.get("organizationId"))
      .first<{ document_key: string | null }>();
    if (linked?.document_key === key) {
      return respond(context, employeeFormsRoutes.upload, {
        filename,
        status: "submitted",
      });
    }
    await context.env.STORAGE.delete(key).catch(console.error);
    throw cause;
  }
  return respond(context, employeeFormsRoutes.upload, {
    filename,
    status: "submitted",
  });
});

employeeFormDocuments.get("/:id/document", async (context) => {
  const row = await findRequirement(context);
  if (
    !row ||
    !(await canAccessRequirement(context, row)) ||
    !row.document_key
  ) {
    return context.json({ error: "Document not found." }, 404);
  }
  const download = await storedDownload(context.env.STORAGE, row.document_key, {
    fallbackFilename: "document",
    filename: row.document_filename ?? "document",
    headers: {
      "cache-control": "private, no-store",
      "x-document-revision": String(row.document_revision),
    },
  });
  return download ?? context.json({ error: "Document not found." }, 404);
});
