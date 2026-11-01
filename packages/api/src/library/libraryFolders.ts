import {
  type LibraryFolder,
  libraryFoldersRoutes,
} from "@balebase/validators/libraryFolders";
import { libraryFolderNameMaxLength } from "@balebase/validators/rules";
import { type Context, Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import {
  deletedTargetLinkEvents,
  listLinkedEmails,
  toLinkedEmail,
} from "../inbox/inboundEmailLinks";
import {
  activityBatch,
  findActivity,
  insertActivity,
} from "../shared/activity";
import { readBody, respond } from "../shared/respond";

type LibraryContext = Context<ApiEnv>;

interface FolderRow {
  created_at: string;
  email_count: number;
  file_count: number;
  id: string;
  name: string;
}

const invalidName = `Folder names need 1 to ${libraryFolderNameMaxLength} characters.`;

const folderSelect = `
  SELECT folder.id, folder.name, folder.created_at,
         (SELECT COUNT(*) FROM objects AS object
          WHERE object.organization_id = folder.organization_id
            AND object.kind = 'library' AND object.folder_id = folder.id)
           AS file_count,
         (SELECT COUNT(*) FROM inbound_email_links AS link
          JOIN inbound_emails AS email ON email.id = link.email_id
          WHERE link.organization_id = folder.organization_id
            AND link.target_type = 'library_folder'
            AND link.target_id = folder.id
            AND email.deleted_at IS NULL)
           AS email_count
  FROM library_folders AS folder`;

const libraryFolders = new Hono<ApiEnv>();

libraryFolders.get("/", async (context) => {
  const result = await context.env.DB.prepare(
    `${folderSelect} WHERE folder.organization_id = ?
     ORDER BY folder.name COLLATE NOCASE ASC`,
  )
    .bind(context.get("organizationId"))
    .all<FolderRow>();
  return respond(context, libraryFoldersRoutes.list, {
    folders: result.results.map(toFolder),
  });
});

libraryFolders.post("/", async (context) => {
  const input = await readBody(
    context,
    libraryFoldersRoutes.create,
    invalidName,
  );
  if (input instanceof Response) return input;
  const { name } = input;
  const organizationId = context.get("organizationId");
  if (await nameTaken(context.env.DB, organizationId, name)) {
    return duplicateName(context);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const database = context.env.DB;
  await activityBatch(database, context.get("apiKey"), [
    database
      .prepare(
        `INSERT INTO library_folders
           (id, organization_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(id, organizationId, name, now, now),
    folderEvent(context, id, {
      action: "library.folder_created",
      details: "json_object('name', folder.name)",
    }),
  ]);
  return respond(
    context,
    libraryFoldersRoutes.create,
    { folder: { createdAt: now, emailCount: 0, fileCount: 0, id, name } },
    201,
  );
});

libraryFolders.get("/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const folder = await context.env.DB.prepare(
    `${folderSelect} WHERE folder.id = ? AND folder.organization_id = ?`,
  )
    .bind(context.req.param("id"), organizationId)
    .first<FolderRow>();
  if (!folder) return folderNotFound(context);
  const emails = await listLinkedEmails(
    context.env.DB,
    organizationId,
    "library_folder",
    folder.id,
  );
  return respond(context, libraryFoldersRoutes.get, {
    emails: emails.map(toLinkedEmail),
    folder: toFolder(folder),
  });
});

libraryFolders.patch("/:id", async (context) => {
  const id = context.req.param("id");
  const input = await readBody(
    context,
    libraryFoldersRoutes.rename,
    invalidName,
  );
  if (input instanceof Response) return input;
  const { name } = input;
  const organizationId = context.get("organizationId");
  if (!(await findLibraryFolder(context.env.DB, organizationId, id))) {
    return folderNotFound(context);
  }
  if (await nameTaken(context.env.DB, organizationId, name, id)) {
    return duplicateName(context);
  }
  // The event reads the old name in the batch. Renaming a folder to its
  // current name, letter case included, changes and records nothing.
  const database = context.env.DB;
  await activityBatch(database, context.get("apiKey"), [
    folderEvent(context, id, {
      action: "library.folder_renamed",
      detailBindings: [name],
      details: "json_object('before', folder.name, 'after', ?)",
      label: name,
      when: { bindings: [name], sql: "folder.name IS NOT ?" },
    }),
    database
      .prepare(
        `UPDATE library_folders SET name = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND name IS NOT ?`,
      )
      .bind(name, new Date().toISOString(), id, organizationId, name),
  ]);
  return respond(context, libraryFoldersRoutes.rename, {
    folder: { id, name },
  });
});

libraryFolders.delete("/:id", async (context) => {
  const id = context.req.param("id");
  const organizationId = context.get("organizationId");
  if (!(await findLibraryFolder(context.env.DB, organizationId, id))) {
    return folderNotFound(context);
  }
  // Return documents to the library root and drop email links explicitly
  // rather than relying on the foreign-key action and trigger alone. The
  // event counts what the deletion unfiles and unlinks, and outlives the
  // folder until the organization is purged. Each file returned to the root
  // and each email link removed is also recorded on its own record, so the
  // file's and the email's histories show the change.
  const actorId = context.get("authSession").user.id;
  await activityBatch(context.env.DB, context.get("apiKey"), [
    unfiledFileEvents(context, id),
    deletedTargetLinkEvents(context.env.DB, {
      actorId,
      organizationId,
      targetId: id,
      targetType: "library_folder",
    }),
    folderEvent(context, id, {
      action: "library.folder_deleted",
      details: `json_object(
         'name', folder.name,
         'fileCount', (SELECT COUNT(*) FROM objects
                       WHERE organization_id = folder.organization_id
                         AND folder_id = folder.id),
         'emailLinkCount', (SELECT COUNT(*) FROM inbound_email_links
                            WHERE organization_id = folder.organization_id
                              AND target_type = 'library_folder'
                              AND target_id = folder.id))`,
    }),
    context.env.DB.prepare(
      `UPDATE objects SET folder_id = NULL
       WHERE organization_id = ? AND folder_id = ?`,
    ).bind(organizationId, id),
    context.env.DB.prepare(
      `DELETE FROM inbound_email_links
       WHERE organization_id = ? AND target_type = 'library_folder'
         AND target_id = ?`,
    ).bind(organizationId, id),
    context.env.DB.prepare(
      `DELETE FROM library_folders WHERE id = ? AND organization_id = ?`,
    ).bind(id, organizationId),
  ]);
  return context.body(null, 204);
});

libraryFolders.get("/:id/activity", async (context) => {
  const organizationId = context.get("organizationId");
  const folder = await findLibraryFolder(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!folder) return folderNotFound(context);
  const page = await findActivity(
    context.env.DB,
    organizationId,
    context.req.query("cursor"),
    { id: folder.id, includeFolderFiles: true, type: "library_folder" },
  );
  return page
    ? respond(context, libraryFoldersRoutes.activity, page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});

/**
 * One `library.file_moved` per file a folder's deletion returns to the
 * library root, read from the stored rows in the batch and attributed to the
 * person deleting the folder.
 */
function unfiledFileEvents(context: LibraryContext, folderId: string) {
  return context.env.DB.prepare(
    `${insertActivity}
     SELECT objects.organization_id, 'library_file', objects.id,
            objects.filename, 'library_file', objects.id,
            'library.file_moved', actor.id, actor.name, actor.email, ?,
            json_object('filename', objects.filename,
                        'fromFolderId', folder.id,
                        'fromFolderName', folder.name,
                        'toFolderId', NULL, 'toFolderName', NULL,
                        'via', 'folder_deleted')
     FROM objects
     JOIN library_folders AS folder
       ON folder.id = objects.folder_id
      AND folder.organization_id = objects.organization_id
     JOIN user AS actor ON actor.id = ?
     WHERE objects.organization_id = ? AND objects.kind = 'library'
       AND objects.folder_id = ?
     ORDER BY objects.created_at, objects.id`,
  ).bind(
    new Date().toISOString(),
    context.get("authSession").user.id,
    context.get("organizationId"),
    folderId,
  );
}

/**
 * Records a folder event in the batch, labelled with the folder's stored name
 * unless a new `label` is given, and only while the folder exists and `when`
 * holds. `details` is SQL over `folder`.
 */
function folderEvent(
  context: LibraryContext,
  id: string,
  event: {
    action: string;
    detailBindings?: string[];
    details: string;
    label?: string;
    when?: { bindings: string[]; sql: string };
  },
) {
  const when = event.when ?? { bindings: [], sql: "1" };
  return context.env.DB.prepare(
    `${insertActivity}
     SELECT folder.organization_id, 'library_folder', folder.id,
            ${event.label === undefined ? "folder.name" : "?"},
            'library_folder', folder.id, ?, actor.id, actor.name, actor.email,
            ?, ${event.details}
     FROM library_folders AS folder
     JOIN user AS actor ON actor.id = ?
     WHERE folder.id = ? AND folder.organization_id = ? AND (${when.sql})`,
  ).bind(
    ...(event.label === undefined ? [] : [event.label]),
    event.action,
    new Date().toISOString(),
    ...(event.detailBindings ?? []),
    context.get("authSession").user.id,
    id,
    context.get("organizationId"),
    ...when.bindings,
  );
}

export async function findLibraryFolder(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT id, name FROM library_folders
       WHERE id = ? AND organization_id = ?`,
    )
    .bind(id, organizationId)
    .first<{ id: string; name: string }>();
}

async function nameTaken(
  database: D1Database,
  organizationId: string,
  name: string,
  exceptId?: string,
) {
  const existing = await database
    .prepare(
      `SELECT id FROM library_folders
       WHERE organization_id = ? AND name = ? COLLATE NOCASE`,
    )
    .bind(organizationId, name)
    .first<{ id: string }>();
  return Boolean(existing && existing.id !== exceptId);
}

function toFolder(row: FolderRow): LibraryFolder {
  return {
    createdAt: row.created_at,
    emailCount: row.email_count,
    fileCount: row.file_count,
    id: row.id,
    name: row.name,
  };
}

function duplicateName(context: LibraryContext) {
  return context.json({ error: "A folder with that name exists." }, 409);
}

function folderNotFound(context: LibraryContext) {
  return context.json({ error: "Folder not found." }, 404);
}

export { libraryFolders };
