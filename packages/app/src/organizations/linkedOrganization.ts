import { useEffect } from "react";

interface Workspace {
  activeOrganizationId: string | undefined;
  organizations: Array<{ id: string }>;
  switchOrganization: (organizationId: string) => Promise<void>;
}

/**
 * Opens a link that names its organization, such as an emailed background
 * check, in that organization: once the person's organizations load, it
 * switches to the named one if they belong to it, before that organization's
 * access rules apply. The parameter is removed so it switches only once.
 */
export function useLinkedOrganization(workspace: Workspace) {
  const loaded = workspace.organizations.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the organizations first load.
  useEffect(() => {
    if (!loaded) return;
    const params = new URLSearchParams(window.location.search);
    const linked = params.get("organization");
    if (!linked) return;
    params.delete("organization");
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${params.size ? `?${params}` : ""}${window.location.hash}`,
    );
    if (
      linked !== workspace.activeOrganizationId &&
      workspace.organizations.some(({ id }) => id === linked)
    ) {
      workspace.switchOrganization(linked).catch((cause: unknown) => {
        console.error("Could not open the linked organization.", cause);
      });
    }
  }, [loaded]);
}
