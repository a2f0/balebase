export function addAccountPath(returnTo: string) {
  const parameters = new URLSearchParams({ returnTo });
  return `/add-account?${parameters.toString()}`;
}

export function accountReturnPath(search: string, origin: string) {
  const returnTo = new URLSearchParams(search).get("returnTo");
  if (!returnTo) return "/";
  try {
    const target = new URL(returnTo, origin);
    const source = new URL(origin);
    if (target.protocol !== source.protocol || target.host !== source.host)
      return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

export function invitationIdForPath(path: string, origin: string) {
  try {
    const target = new URL(path, origin);
    const source = new URL(origin);
    if (
      target.protocol !== source.protocol ||
      target.host !== source.host ||
      target.pathname !== "/invite"
    ) {
      return undefined;
    }
    return target.searchParams.get("id")?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function workspaceContentKey(
  pathname: string,
  userId: string,
  organizationId: string | undefined,
) {
  if (pathname === "/invite") return `organization-invitation:${userId}`;
  return `${userId}:${organizationId ?? ""}`;
}
