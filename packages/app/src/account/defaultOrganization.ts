import { balebase } from "../balebase";

/** Saves the organization the user opens on sign-in, then reloads the session. */
export async function saveDefaultOrganizationPreference(
  organizationId: string,
  refreshSession: () => Promise<unknown>,
) {
  await balebase().api.accountSettings.updateDefaultOrganization(
    organizationId,
  );
  await refreshSession();
}
