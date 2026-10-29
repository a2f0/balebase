import type { adminUsersRoutes } from "@balebase/validators/adminUsers";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof adminUsersRoutes.list>({
    method: "GET",
    path: "/api/admin/users",
    response: "json",
  }),
  markForDeletion: endpoint<typeof adminUsersRoutes.markForDeletion>({
    method: "POST",
    path: "/api/admin/users/:userId/deletion",
    body: "json",
    response: "json",
  }),
  cancelDeletion: endpoint<typeof adminUsersRoutes.cancelDeletion>({
    method: "DELETE",
    path: "/api/admin/users/:userId/deletion",
    response: "json",
  }),
  revokeAdmin: endpoint<typeof adminUsersRoutes.revokeAdmin>({
    method: "DELETE",
    path: "/api/admin/users/:userId/admin",
    response: "json",
  }),
};

export function adminUsersApi(transport: Transport) {
  return {
    list(query: { limit: number; offset: number }) {
      return transport.call(endpoints.list, { query });
    },
    markForDeletion(userId: string, email: string) {
      return transport.call(endpoints.markForDeletion, {
        params: { userId },
        body: { confirm: email },
      });
    },
    cancelDeletion(userId: string) {
      return transport.call(endpoints.cancelDeletion, { params: { userId } });
    },
    revokeAdmin(userId: string) {
      return transport.call(endpoints.revokeAdmin, { params: { userId } });
    },
  };
}
