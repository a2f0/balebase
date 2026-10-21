import { z } from "zod";
import { route } from "./route";

/** A library document, at the root or in a folder. */
const StoredObjectSchema = z.object({
  contentType: z.string(),
  createdAt: z.string(),
  filename: z.string(),
  /** Null at the library root. */
  folderId: z.string().nullable(),
  id: z.string(),
  objectKey: z.string(),
  size: z.number(),
});
export type StoredObject = z.infer<typeof StoredObjectSchema>;

const StoredObjectResponseSchema = z.object({ object: StoredObjectSchema });

export const objectsRoutes = {
  list: route({
    method: "GET",
    path: "/api/objects",
    /** A folder's id; the library root when absent. */
    query: z.object({ folder: z.string().optional() }),
    response: z.object({ objects: z.array(StoredObjectSchema) }),
  }),
  /** A multipart form with a `file` and, optionally, a `folderId`. */
  upload: route({
    method: "POST",
    path: "/api/objects",
    body: "form",
    response: StoredObjectResponseSchema,
  }),
  download: route({
    method: "GET",
    path: "/api/objects/:id",
    response: "file",
  }),
  move: route({
    method: "PATCH",
    path: "/api/objects/:id",
    /** A folder's id, or null for the library root. */
    body: z.object({ folderId: z.string().nullable() }),
    response: StoredObjectResponseSchema,
  }),
  delete: route({
    method: "DELETE",
    path: "/api/objects/:id",
    response: "empty",
  }),
};
