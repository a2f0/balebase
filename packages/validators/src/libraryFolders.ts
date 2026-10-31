import { z } from "zod";
import { ActivityPageSchema, ActivityQuerySchema } from "./activity";
import { lineName } from "./fields";
import { LinkedEmailSchema } from "./inbox";
import { route } from "./route";
import { libraryFolderNameMaxLength } from "./rules";

const LibraryFolderSchema = z.object({
  createdAt: z.string(),
  /** Linked emails outside Trash. */
  emailCount: z.number(),
  fileCount: z.number(),
  id: z.string(),
  name: z.string(),
});
export type LibraryFolder = z.infer<typeof LibraryFolderSchema>;

const LibraryFolderDetailSchema = z.object({
  emails: z.array(LinkedEmailSchema),
  folder: LibraryFolderSchema,
});
export type LibraryFolderDetail = z.infer<typeof LibraryFolderDetailSchema>;

const folderNameRule = `Folder names need 1 to ${libraryFolderNameMaxLength} characters.`;
const FolderNameSchema = z.object(
  { name: lineName(libraryFolderNameMaxLength, folderNameRule) },
  { error: folderNameRule },
);

export const libraryFoldersRoutes = {
  list: route({
    method: "GET",
    path: "/api/library/folders",
    response: z.object({ folders: z.array(LibraryFolderSchema) }),
  }),
  create: route({
    method: "POST",
    path: "/api/library/folders",
    body: FolderNameSchema,
    response: z.object({ folder: LibraryFolderSchema }),
  }),
  get: route({
    method: "GET",
    path: "/api/library/folders/:id",
    response: LibraryFolderDetailSchema,
  }),
  activity: route({
    method: "GET",
    path: "/api/library/folders/:id/activity",
    query: ActivityQuerySchema,
    response: ActivityPageSchema,
  }),
  rename: route({
    method: "PATCH",
    path: "/api/library/folders/:id",
    body: FolderNameSchema,
    response: z.object({
      folder: z.object({ id: z.string(), name: z.string() }),
    }),
  }),
  delete: route({
    method: "DELETE",
    path: "/api/library/folders/:id",
    response: "empty",
  }),
};
