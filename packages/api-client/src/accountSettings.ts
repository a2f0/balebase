import type { accountSettingsRoutes } from "@balebase/validators/accountSettings";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  updateDefaultOrganization: endpoint<
    typeof accountSettingsRoutes.updateDefaultOrganization
  >({
    method: "PATCH",
    path: "/api/account-settings/default-organization",
    body: "json",
    response: "json",
  }),
  securityEvents: endpoint<typeof accountSettingsRoutes.securityEvents>({
    method: "GET",
    path: "/api/account-settings/security-events",
    response: "json",
  }),
  deletion: endpoint<typeof accountSettingsRoutes.deletion>({
    method: "GET",
    path: "/api/account-settings/deletion",
    response: "json",
  }),
  requestDeletion: endpoint<typeof accountSettingsRoutes.requestDeletion>({
    method: "POST",
    path: "/api/account-settings/deletion",
    body: "json",
    response: "json",
  }),
  cancelDeletion: endpoint<typeof accountSettingsRoutes.cancelDeletion>({
    method: "DELETE",
    path: "/api/account-settings/deletion",
    response: "json",
  }),
};

export function accountSettingsApi(transport: Transport) {
  return {
    /** Pins the organization the user opens on sign-in. */
    updateDefaultOrganization(organizationId: string) {
      return transport.call(endpoints.updateDefaultOrganization, {
        body: { organizationId },
      });
    },
    /** The signed-in person's latest two-factor and password changes. */
    securityEvents() {
      return transport.call(endpoints.securityEvents);
    },
    deletion() {
      return transport.call(endpoints.deletion);
    },
    /** Asks for the account to be purged after the waiting period. */
    requestDeletion() {
      return transport.call(endpoints.requestDeletion, {
        body: { confirm: "delete my account" },
      });
    },
    cancelDeletion() {
      return transport.call(endpoints.cancelDeletion);
    },
  };
}
