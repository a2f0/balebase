import type { adminOrganizationsRoutes } from "@balebase/validators/adminOrganizations";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof adminOrganizationsRoutes.list>({
    method: "GET",
    path: "/api/admin/organizations",
    response: "json",
  }),
  get: endpoint<typeof adminOrganizationsRoutes.get>({
    method: "GET",
    path: "/api/admin/organizations/:organizationId",
    response: "json",
  }),
  markForDeletion: endpoint<typeof adminOrganizationsRoutes.markForDeletion>({
    method: "DELETE",
    path: "/api/admin/organizations/:organizationId",
    response: "json",
  }),
  restore: endpoint<typeof adminOrganizationsRoutes.restore>({
    method: "POST",
    path: "/api/admin/organizations/:organizationId/restore",
    response: "json",
  }),
};

export function adminOrganizationsApi(transport: Transport) {
  return {
    /** The 100 newest organizations, including those marked for deletion. */
    async list() {
      const body = await transport.call(endpoints.list);
      return body.organizations;
    },
    get(organizationId: string) {
      return transport.call(endpoints.get, {
        params: { organizationId },
      });
    },
    markForDeletion(organizationId: string) {
      return transport.call(endpoints.markForDeletion, {
        params: { organizationId },
      });
    },
    restore(organizationId: string) {
      return transport.call(endpoints.restore, {
        params: { organizationId },
      });
    },
  };
}
