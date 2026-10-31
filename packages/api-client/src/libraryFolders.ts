import type { libraryFoldersRoutes } from "@balebase/validators/libraryFolders";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof libraryFoldersRoutes.list>({
    method: "GET",
    path: "/api/library/folders",
    response: "json",
  }),
  create: endpoint<typeof libraryFoldersRoutes.create>({
    method: "POST",
    path: "/api/library/folders",
    body: "json",
    response: "json",
  }),
  get: endpoint<typeof libraryFoldersRoutes.get>({
    method: "GET",
    path: "/api/library/folders/:id",
    response: "json",
  }),
  activity: endpoint<typeof libraryFoldersRoutes.activity>({
    method: "GET",
    path: "/api/library/folders/:id/activity",
    response: "json",
  }),
  rename: endpoint<typeof libraryFoldersRoutes.rename>({
    method: "PATCH",
    path: "/api/library/folders/:id",
    body: "json",
    response: "json",
  }),
  delete: endpoint<typeof libraryFoldersRoutes.delete>({
    method: "DELETE",
    path: "/api/library/folders/:id",
    response: "empty",
  }),
};

export function libraryFoldersApi(transport: Transport) {
  return {
    async list() {
      const { folders } = await transport.call(endpoints.list);
      return folders;
    },
    /** A folder and the emails linked to it. */
    get(id: string) {
      return transport.call(endpoints.get, { params: { id } });
    },
    /** The folder's history, including emails linked to it, newest first. */
    activity(id: string, cursor?: string) {
      return transport.call(endpoints.activity, {
        params: { id },
        query: { cursor },
      });
    },
    async create(name: string) {
      const { folder } = await transport.call(endpoints.create, {
        body: { name },
      });
      return folder;
    },
    rename(id: string, name: string) {
      return transport.call(endpoints.rename, {
        body: { name },
        params: { id },
      });
    },
    /** Deletes a folder, returning its documents to the library root. */
    delete(id: string) {
      return transport.call(endpoints.delete, { params: { id } });
    },
  };
}
