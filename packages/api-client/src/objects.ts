import type { objectsRoutes } from "@balebase/validators/objects";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof objectsRoutes.list>({
    method: "GET",
    path: "/api/objects",
    response: "json",
  }),
  upload: endpoint<typeof objectsRoutes.upload>({
    method: "POST",
    path: "/api/objects",
    body: "form",
    response: "json",
  }),
  download: endpoint<typeof objectsRoutes.download>({
    method: "GET",
    path: "/api/objects/:id",
    response: "file",
  }),
  move: endpoint<typeof objectsRoutes.move>({
    method: "PATCH",
    path: "/api/objects/:id",
    body: "json",
    response: "json",
  }),
  delete: endpoint<typeof objectsRoutes.delete>({
    method: "DELETE",
    path: "/api/objects/:id",
    response: "empty",
  }),
};

export function objectsApi(transport: Transport) {
  return {
    /** Lists one folder's files, or the files at the library root. */
    async list(folderId?: string) {
      const { objects } = await transport.call(endpoints.list, {
        query: { folder: folderId || undefined },
      });
      return objects;
    },
    upload(file: File, folderId?: string) {
      const form = new FormData();
      form.set("file", file);
      if (folderId) form.set("folderId", folderId);
      return transport.call(endpoints.upload, { body: form });
    },
    downloadUrl(id: string) {
      return transport.url(endpoints.download, { params: { id } });
    },
    /** Moves a file into a folder, or back to the library root with null. */
    async move(id: string, folderId: string | null) {
      const { object } = await transport.call(endpoints.move, {
        body: { folderId },
        params: { id },
      });
      return object;
    },
    delete(id: string) {
      return transport.call(endpoints.delete, { params: { id } });
    },
  };
}
