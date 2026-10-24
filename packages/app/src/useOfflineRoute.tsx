import { useEffect, useMemo } from "react";
import { OfflineWorkspacePage } from "./OfflineWorkspacePage";
import {
  activeOfflineKey,
  lockOfflineWorkspace,
  lockOtherOfflineWorkspace,
  type OfflineWorkspace,
  offlineScopeKey,
} from "./offlineStore";
import { useOfflineWorkspace } from "./useOfflineWorkspace";
import { signingTokenForPath } from "./workspacePaths";

interface OfflineSession {
  user: { id: string; name: string; email: string };
  session?: { activeOrganizationId?: string | null | undefined };
}
interface Workspace {
  activeOrganizationId: string | undefined;
  organizations: { id: string; name: string }[];
}

export function useOfflineRoute(
  session: OfflineSession | null | undefined,
  workspace: Workspace,
  access: { memberRole: string | undefined; loadError: string | undefined },
  pathname: string,
  navigate: (path: string) => void,
  isPending: boolean,
  sessionError: unknown,
) {
  const offline = useOfflineWorkspace();
  const user = session?.user;
  const organizationId = workspace.activeOrganizationId;
  const confirmedOrganizationId =
    session?.session?.activeOrganizationId ?? organizationId;
  const organizationName =
    workspace.organizations.find((entry) => entry.id === organizationId)
      ?.name ?? "Organization";
  const identity = useMemo(
    () =>
      user && organizationId && access.memberRole && !access.loadError
        ? {
            scope: { userId: user.id, organizationId },
            user: { id: user.id, name: user.name, email: user.email },
            organizationName,
          }
        : undefined,
    [
      user,
      organizationId,
      access.memberRole,
      access.loadError,
      organizationName,
    ],
  );
  useEffect(() => {
    if (pathname === "/add-account") lockOfflineWorkspace();
    else if (session)
      lockOtherOfflineWorkspace(session.user.id, confirmedOrganizationId);
    else if (!isPending && !sessionError && navigator.onLine)
      lockOfflineWorkspace();
  }, [isPending, sessionError, session, confirmedOrganizationId, pathname]);
  const excluded =
    ["/add-account", "/reset-password"].includes(pathname) ||
    Boolean(signingTokenForPath(pathname));
  const local = matchingWorkspace(
    offline.workspace,
    user,
    confirmedOrganizationId,
  );
  const fallback = Boolean(
    !excluded &&
      (!offline.online || sessionError) &&
      local &&
      (pathname === "/offline" || !session || sessionError),
  );
  useEffect(() => {
    // Give a cold offline reopen its own route before account revalidation
    // begins, so reconnecting never replaces an in-progress local editor.
    if (fallback && pathname !== "/offline") navigate("/offline");
  }, [fallback, pathname, navigate]);
  if (excluded) return undefined;
  if (local && (pathname === "/offline" || fallback)) {
    return (
      <OfflineWorkspacePage
        key={local.key}
        workspace={local}
        identity={identity}
        online={offline.online}
        onNavigate={navigate}
        storageError={offline.error}
      />
    );
  }
  if (pathname === "/offline" && identity) {
    return (
      <OfflineWorkspacePage
        key={offlineScopeKey(identity.scope)}
        workspace={
          local?.key === offlineScopeKey(identity.scope) ? local : undefined
        }
        identity={identity}
        online={offline.online}
        onNavigate={navigate}
        storageError={offline.error}
      />
    );
  }
  return undefined;
}

function matchingWorkspace(
  saved: OfflineWorkspace | undefined,
  user: OfflineSession["user"] | undefined,
  organizationId: string | undefined,
) {
  if (!saved || saved.key !== activeOfflineKey()) return undefined;
  if (
    user &&
    (saved.scope.userId !== user.id ||
      (organizationId && saved.scope.organizationId !== organizationId))
  )
    return undefined;
  return saved;
}
