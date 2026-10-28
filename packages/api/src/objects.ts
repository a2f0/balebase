import { objectsRoutes } from "@balebase/validators/objects";
import { type Context, Hono } from "hono";
import type { ApiEnv } from "./authMiddleware";
import { maxFilenameBytes, normalizeFilename } from "./filenames";
import { findLibraryFolder } from "./libraryFolders";
import { respond } from "./respond";
import {
  readBoundedForm,
  storedDownload,
  trackedPut,
  uploadExpired,
  uploadStillQueued,
} from "./storage";
import type { Bindings, StoredObjectRow } from "./types";
import { toStoredObject } from "./types";

const objects = new Hono<ApiEnv>();
const maxUploadBytes = 25 * 1024 * 1024;
const uploadTooLarge = "Files must be 25 MB or smaller.";
const maxR2ObjectKeyBytes = 1_024;

// Lists one folder's documents, or the documents at the library root.
objects.get("/", async (context) => {
  const organizationId = context.get("organizationId");
  const folderId = context.req.query("folder") || null;
  if (
    folderId &&
    !(await findLibraryFolder(context.env.DB, organizationId, folderId))
  ) {
    return folderNotFound(context);
  }
  const result = await context.env.DB.prepare(
    `SELECT id, object_key, filename, content_type, size, created_at,
            folder_id
     FROM objects
     WHERE organization_id = ? AND kind = 'library' AND folder_id IS ?
     ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(organizationId, folderId)
    .all<StoredObjectRow>();

  return respond(context, objectsRoutes.list, {
    objects: result.results.map(toStoredObject),
  });
});

objects.post("/", async (context) => {
  const form = await readBoundedForm(context.req.raw, maxUploadBytes);
  if (form === "too_large") {
    return context.json({ error: uploadTooLarge }, 413);
  }
  const file = form?.get("file");
  const folderField = form?.get("folderId");
  const folderId =
    typeof folderField === "string" && folderField ? folderField : null;

  if (!(file instanceof File)) {
    return context.json({ error: "A multipart file field is required." }, 400);
  }

  if (file.size > maxUploadBytes) {
    return context.json({ error: uploadTooLarge }, 413);
  }

  const id = crypto.randomUUID();
  const organizationId = context.get("organizationId");
  if (
    folderId &&
    !(await findLibraryFolder(context.env.DB, organizationId, folderId))
  ) {
    return folderNotFound(context);
  }
  const objectKeyPrefix = `organizations/${organizationId}/uploads/${id}/`;
  const filenameByteBudget =
    maxR2ObjectKeyBytes - new TextEncoder().encode(objectKeyPrefix).byteLength;
  if (filenameByteBudget < 1) {
    return context.json(
      { error: "Organization storage path is too long." },
      500,
    );
  }
  const filename = normalizeFilename(
    file.name,
    "upload",
    Math.min(maxFilenameBytes, filenameByteBudget),
  );
  const objectKey = `${objectKeyPrefix}${filename}`;
  const contentType = file.type || "application/octet-stream";
  const createdAt = new Date().toISOString();

  const stored = await storeLibraryObject(context.env, file, {
    content_type: contentType,
    created_at: createdAt,
    filename,
    folder_id: folderId,
    id,
    object_key: objectKey,
    organization_id: organizationId,
    size: file.size,
  });
  if (!stored) return context.json({ error: uploadExpired }, 409);

  return respond(
    context,
    objectsRoutes.upload,
    {
      object: {
        folderId,
        id,
        objectKey,
        filename,
        contentType,
        size: file.size,
        createdAt,
      },
    },
    201,
  );
});

objects.get("/:id", async (context) => {
  const row = await findObject(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
  );
  if (!row) {
    return context.json({ error: "Object not found." }, 404);
  }

  const download = await storedDownload(context.env.STORAGE, row.object_key, {
    fallbackFilename: "download",
    filename: row.filename,
  });
  return download ?? context.json({ error: "Object data not found." }, 404);
});

// Moves a document into a folder, or back to the library root with null.
objects.patch("/:id", async (context) => {
  const input: unknown = await context.req.json().catch(() => null);
  const folderId = folderIdFrom(input);
  if (folderId === undefined) {
    return context.json({ error: "A folder or null is required." }, 400);
  }
  const organizationId = context.get("organizationId");
  const row = await findObject(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!row) {
    return context.json({ error: "Object not found." }, 404);
  }
  if (
    folderId &&
    !(await findLibraryFolder(context.env.DB, organizationId, folderId))
  ) {
    return folderNotFound(context);
  }
  await context.env.DB.prepare(
    `UPDATE objects SET folder_id = ?
     WHERE id = ? AND organization_id = ? AND kind = 'library'`,
  )
    .bind(folderId, row.id, organizationId)
    .run();
  return respond(context, objectsRoutes.move, {
    object: toStoredObject({ ...row, folder_id: folderId }),
  });
});

objects.delete("/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const row = await findObject(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!row) {
    return context.json({ error: "Object not found." }, 404);
  }

  await context.env.STORAGE.delete(row.object_key);
  await context.env.DB.prepare(
    `DELETE FROM objects
     WHERE id = ? AND organization_id = ? AND kind = 'library'`,
  )
    .bind(row.id, organizationId)
    .run();

  return context.body(null, 204);
});

async function storeLibraryObject(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  file: File,
  row: StoredObjectRow & { organization_id: string },
) {
  await trackedPut(
    environment,
    {
      cleanupId: `library-upload:${row.id}`,
      key: row.object_key,
      organizationId: row.organization_id,
    },
    file,
    {
      httpMetadata: { contentType: row.content_type },
      customMetadata: {
        filename: row.filename,
        organizationId: row.organization_id,
      },
    },
  );
  try {
    const inserted = await environment.DB.prepare(
      `INSERT INTO objects
       (id, organization_id, object_key, filename, content_type, size,
        created_at, kind, folder_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'library', ? WHERE ${uploadStillQueued}`,
    )
      .bind(
        row.id,
        row.organization_id,
        row.object_key,
        row.filename,
        row.content_type,
        row.size,
        row.created_at,
        row.folder_id,
        row.object_key,
      )
      .run();
    if (inserted.meta.changes) return true;
  } catch (error) {
    await environment.STORAGE.delete(row.object_key);
    throw error;
  }
  await environment.STORAGE.delete(row.object_key);
  return false;
}

async function findObject(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT id, object_key, filename, content_type, size, created_at,
              folder_id
       FROM objects
       WHERE id = ? AND organization_id = ? AND kind = 'library'`,
    )
    .bind(id, organizationId)
    .first<StoredObjectRow>();
}

/** A folder id, null for the library root, or undefined when invalid. */
function folderIdFrom(input: unknown) {
  if (typeof input !== "object" || input === null) return undefined;
  const folderId = Reflect.get(input, "folderId");
  if (folderId === null) return null;
  return typeof folderId === "string" &&
    folderId.length > 0 &&
    folderId.length <= 100
    ? folderId
    : undefined;
}

function folderNotFound(context: Context) {
  return context.json({ error: "Folder not found." }, 404);
}

export { objects };
