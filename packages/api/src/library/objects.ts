import { objectsRoutes } from "@balebase/validators/objects";
import { type Context, Hono } from "hono";
import type { ApiEnv, ApiKeyPrincipal } from "../auth/apiEnv";
import {
  activityBatch,
  findActivity,
  insertActivity,
} from "../shared/activity";
import { maxFilenameBytes, normalizeFilename } from "../shared/filenames";
import { readBody, respond } from "../shared/respond";
import {
  readBoundedForm,
  storedDownload,
  trackedPut,
  uploadExpired,
  uploadStillQueued,
} from "../shared/storage";
import type { Bindings, StoredObjectRow } from "../types";
import { toStoredObject } from "../types";
import { findLibraryFolder } from "./libraryFolders";

const objects = new Hono<ApiEnv>();
const maxUploadBytes = 25 * 1024 * 1024;
const uploadTooLarge = "Files must be 25 MB or smaller.";
const maxR2ObjectKeyBytes = 1_024;

/** What a file event records: never its contents or storage key. */
const fileDetails = `json_object('filename', objects.filename,
  'contentType', objects.content_type, 'size', objects.size,
  'folderId', objects.folder_id, 'folderName', folder.name)`;

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

  const stored = await storeLibraryObject(
    context.env,
    file,
    {
      content_type: contentType,
      created_at: createdAt,
      filename,
      folder_id: folderId,
      id,
      object_key: objectKey,
      organization_id: organizationId,
      size: file.size,
    },
    {
      apiKey: context.get("apiKey"),
      userId: context.get("authSession").user.id,
    },
  );
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

// A file's history: its upload, moves, and deletion. Every member can read
// file events in the shared feed, so the history stays readable after the
// file is deleted, for as long as the organization keeps its events.
objects.get("/:id/activity", async (context) => {
  const organizationId = context.get("organizationId");
  const id = context.req.param("id");
  const known = await context.env.DB.prepare(
    `SELECT 1 FROM objects
     WHERE id = ? AND organization_id = ? AND kind = 'library'
     UNION ALL
     SELECT 1 FROM activity_events
     WHERE organization_id = ? AND root_type = 'library_file' AND root_id = ?
     LIMIT 1`,
  )
    .bind(id, organizationId, organizationId, id)
    .first();
  if (!known) return context.json({ error: "Object not found." }, 404);
  const page = await findActivity(
    context.env.DB,
    organizationId,
    context.req.query("cursor"),
    { id, type: "library_file" },
  );
  return page
    ? respond(context, objectsRoutes.activity, page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});

// Moves a document into a folder, or back to the library root with null.
objects.patch("/:id", async (context) => {
  const input = await readBody(
    context,
    objectsRoutes.move,
    "A folder or null is required.",
  );
  if (input instanceof Response) return input;
  const { folderId } = input;
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
  const database = context.env.DB;
  // Moving a document where it already is changes nothing and records
  // nothing. The destination is checked again in the batch, so a folder
  // deleted meanwhile neither gains the document nor an event.
  const moves = `objects.id = ? AND objects.organization_id = ?
    AND objects.kind = 'library' AND objects.folder_id IS NOT ?
    AND (? IS NULL OR EXISTS (
      SELECT 1 FROM library_folders
      WHERE id = ? AND organization_id = objects.organization_id
    ))`;
  const bindings = [row.id, organizationId, folderId, folderId, folderId];
  await activityBatch(database, context.get("apiKey"), [
    database
      .prepare(
        `${insertActivity}
         SELECT objects.organization_id, 'library_file', objects.id,
                objects.filename, 'library_file', objects.id,
                'library.file_moved', actor.id, actor.name, actor.email, ?,
                json_object('filename', objects.filename,
                            'fromFolderId', objects.folder_id,
                            'fromFolderName', source.name,
                            'toFolderId', target.id,
                            'toFolderName', target.name)
         FROM objects
         JOIN user AS actor ON actor.id = ?
         LEFT JOIN library_folders AS source ON source.id = objects.folder_id
         LEFT JOIN library_folders AS target ON target.id = ?
         WHERE ${moves}`,
      )
      .bind(
        new Date().toISOString(),
        context.get("authSession").user.id,
        folderId,
        ...bindings,
      ),
    database
      .prepare(`UPDATE objects SET folder_id = ? WHERE ${moves}`)
      .bind(folderId, ...bindings),
  ]);
  const moved = await findObject(database, organizationId, row.id);
  if (!moved) {
    return context.json({ error: "Object not found." }, 404);
  }
  if (moved.folder_id !== folderId) return folderNotFound(context);
  return respond(context, objectsRoutes.move, {
    object: toStoredObject(moved),
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

  // The event, the row's removal, and a cleanup entry for its bytes commit
  // together, so the history is kept even if removing the bytes fails; the
  // cleanup job then retries it.
  const database = context.env.DB;
  const deletedAt = new Date().toISOString();
  const thisFile = `objects.id = ? AND objects.organization_id = ?
    AND objects.kind = 'library'`;
  const [, , deleted] = await activityBatch(database, context.get("apiKey"), [
    database
      .prepare(
        `${insertActivity}
         SELECT objects.organization_id, 'library_file', objects.id,
                objects.filename, 'library_file', objects.id,
                'library.file_deleted', actor.id, actor.name, actor.email, ?,
                ${fileDetails}
         FROM objects
         JOIN user AS actor ON actor.id = ?
         LEFT JOIN library_folders AS folder ON folder.id = objects.folder_id
         WHERE ${thisFile}`,
      )
      .bind(
        deletedAt,
        context.get("authSession").user.id,
        row.id,
        organizationId,
      ),
    database
      .prepare(
        `INSERT OR REPLACE INTO deleted_object_cleanup
           (id, organization_id, object_key, deleted_at, cleanup_token,
            cleanup_claimed_at)
         SELECT ?, objects.organization_id, objects.object_key, ?, NULL, NULL
         FROM objects WHERE ${thisFile}`,
      )
      .bind(`library-delete:${row.id}`, deletedAt, row.id, organizationId),
    database
      .prepare(`DELETE FROM objects WHERE ${thisFile}`)
      .bind(row.id, organizationId),
  ]);
  if (!deleted?.meta.changes) {
    return context.json({ error: "Object not found." }, 404);
  }
  try {
    await context.env.STORAGE.delete(row.object_key);
    await database
      .prepare(
        `DELETE FROM deleted_object_cleanup
         WHERE id = ? AND cleanup_token IS NULL`,
      )
      .bind(`library-delete:${row.id}`)
      .run();
  } catch (cause) {
    // The file is deleted; its cleanup entry remains for the scheduled retry.
    console.error("Library file cleanup deferred.", cause);
  }

  return context.body(null, 204);
});

async function storeLibraryObject(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  file: File,
  row: StoredObjectRow & { organization_id: string },
  actor: { apiKey: ApiKeyPrincipal | undefined; userId: string },
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
  const database = environment.DB;
  try {
    // The event reads the row this batch inserts, so an expired upload,
    // which inserts nothing, records nothing.
    const [inserted] = await activityBatch(database, actor.apiKey, [
      database
        .prepare(
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
        ),
      database
        .prepare(
          `${insertActivity}
           SELECT objects.organization_id, 'library_file', objects.id,
                  objects.filename, 'library_file', objects.id,
                  'library.file_uploaded', actor.id, actor.name, actor.email,
                  objects.created_at, ${fileDetails}
           FROM objects
           JOIN user AS actor ON actor.id = ?
           LEFT JOIN library_folders AS folder ON folder.id = objects.folder_id
           WHERE objects.id = ? AND objects.organization_id = ?
             AND objects.kind = 'library'`,
        )
        .bind(actor.userId, row.id, row.organization_id),
    ]);
    if (inserted?.meta.changes) return true;
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

function folderNotFound(context: Context) {
  return context.json({ error: "Folder not found." }, 404);
}

export { objects };
