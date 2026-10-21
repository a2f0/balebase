import type {
  OrganizationGroupInput,
  organizationGroupsRoutes,
} from "@balebase/validators/organizationGroups";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  access: endpoint<typeof organizationGroupsRoutes.access>({
    method: "GET",
    path: "/api/organization-groups/access",
    response: "json",
  }),
  list: endpoint<typeof organizationGroupsRoutes.list>({
    method: "GET",
    path: "/api/organization-groups",
    response: "json",
  }),
  create: endpoint<typeof organizationGroupsRoutes.create>({
    method: "POST",
    path: "/api/organization-groups",
    body: "json",
    response: "json",
  }),
  update: endpoint<typeof organizationGroupsRoutes.update>({
    method: "PATCH",
    path: "/api/organization-groups/:id",
    body: "json",
    response: "json",
  }),
  delete: endpoint<typeof organizationGroupsRoutes.delete>({
    method: "DELETE",
    path: "/api/organization-groups/:id",
    response: "empty",
  }),
};

export function organizationGroupsApi(transport: Transport) {
  return {
    /** The signed-in user's role and capabilities in the organization. */
    access() {
      return transport.call(endpoints.access);
    },
    list() {
      return transport.call(endpoints.list);
    },
    create(input: OrganizationGroupInput) {
      return transport.call(endpoints.create, { body: input });
    },
    update(id: string, input: OrganizationGroupInput) {
      return transport.call(endpoints.update, {
        body: input,
        params: { id },
      });
    },
    delete(id: string) {
      return transport.call(endpoints.delete, {
        params: { id },
      });
    },
  };
}
