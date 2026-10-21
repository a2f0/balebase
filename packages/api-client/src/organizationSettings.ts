import type { organizationSettingsRoutes } from "@balebase/validators/organizationSettings";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  organizations: endpoint<typeof organizationSettingsRoutes.organizations>({
    method: "GET",
    path: "/api/organization-settings/organizations",
    response: "json",
  }),
  people: endpoint<typeof organizationSettingsRoutes.people>({
    method: "GET",
    path: "/api/organization-settings/people",
    response: "json",
  }),
  updateMemberTwoFactorRequirement: endpoint<
    typeof organizationSettingsRoutes.updateMemberTwoFactorRequirement
  >({
    method: "PATCH",
    path: "/api/organization-settings/people/:memberId/two-factor-required",
    body: "json",
    response: "json",
  }),
  deleteCurrent: endpoint<typeof organizationSettingsRoutes.deleteCurrent>({
    method: "DELETE",
    path: "/api/organization-settings/current",
    response: "json",
  }),
};

export function organizationSettingsApi(transport: Transport) {
  return {
    /** The organizations the signed-in user belongs to, oldest first. */
    async organizations() {
      const body = await transport.call(endpoints.organizations);
      return body.organizations;
    },
    people() {
      return transport.call(endpoints.people);
    },
    updateMemberTwoFactorRequirement(memberId: string, required: boolean) {
      return transport.call(endpoints.updateMemberTwoFactorRequirement, {
        body: { required },
        params: { memberId },
      });
    },
    /** Marks the active organization for deletion, canceling its billing. */
    deleteCurrent() {
      return transport.call(endpoints.deleteCurrent);
    },
  };
}
