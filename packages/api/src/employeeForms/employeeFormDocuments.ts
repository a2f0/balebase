import { employeeFormsRoutes } from "@balebase/validators/employeeForms";
import { type Context, Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { canManage, stillManages } from "../organizations/organizationMembers";
import { activityBatch, requestActor } from "../shared/activity";
import { normalizeFilename } from "../shared/filenames";
import { respond } from "../shared/respond";
import {
  readBoundedForm,
  storedDownload,
  trackedPut,
  uploadStillQueued,
} from "../shared/storage";
import {
  canAccessRequirement,
  findRequirement,
  type RequirementRow,
} from "./employeeFormRecords";
import {
  jsonBoolean,
  requirementActivityStatement,
} from "./requirementActivity";

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
    const updated = await linkDocument(context, row, {
      filename,
      key,
      size: file.size,
    });
    if (!updated) {
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

/**
 * Links an uploaded document to the requirement and records who uploaded it,
 * in one transaction. A manager may replace the person's document; either way
 * the event is recorded under the update's own guard. Returns whether it
 * linked.
 */
async function linkDocument(
  context: Context<ApiEnv>,
  row: RequirementRow,
  upload: { filename: string; key: string; size: number },
) {
  const organizationId = context.get("organizationId");
  const actor = requestActor(context);
  const manages = canManage(context)
    ? stillManages(organizationId, actor.userId)
    : { bindings: [], sql: "0" };
  const subject = `EXISTS (
    SELECT 1 FROM member WHERE member.id = employee_requirements.member_id
      AND member.organizationId = ? AND member.userId = ?
  )`;
  const guard = {
    bindings: [
      row.id,
      organizationId,
      row.document_key,
      upload.key,
      ...manages.bindings,
      organizationId,
      actor.userId,
    ],
    sql: `id = ? AND organization_id = ? AND document_key IS ?
       AND ${uploadStillQueued}
       AND (${manages.sql} OR ${subject})`,
  };
  const database = context.env.DB;
  const [, updated] = await activityBatch(database, actor.apiKey, [
    requirementActivityStatement(
      database,
      {
        action: "employee_requirement.document_uploaded",
        actorId: actor.userId,
        details: {
          bindings: [organizationId, actor.userId, upload.size],
          sql: `'revision', document_revision + 1,
            'previousRevision', document_revision,
            'replaced', ${jsonBoolean("document_key IS NOT NULL")},
            'previousStatus', status,
            'uploadedBySubject', ${jsonBoolean(subject)},
            'size', ?`,
        },
        organizationId,
        requirementId: row.id,
      },
      guard,
    ),
    database
      .prepare(
        `UPDATE employee_requirements
         SET document_key = ?, document_filename = ?, document_size = ?,
             document_revision = document_revision + 1,
             status = 'submitted', completed_at = NULL, updated_at = ?
         WHERE ${guard.sql}`,
      )
      .bind(
        upload.key,
        upload.filename,
        upload.size,
        new Date().toISOString(),
        ...guard.bindings,
      ),
  ]);
  return Boolean(updated?.meta.changes);
}
