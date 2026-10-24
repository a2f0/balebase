import { useEffect, useMemo } from "react";
import { OfflineWorkspacePage } from "./OfflineWorkspacePage";
import {
  activeOfflineKey,
  lockOfflineWorkspace,
  offlineScopeKey,
} from "./offlineStore";
import { useOfflineWorkspace } from "./useOfflineWorkspace";

interface OfflineSession {
  user: { id: string; name: string; email: string };
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
    if (!isPending && !sessionError && !session && navigator.onLine)
      lockOfflineWorkspace();
  }, [isPending, sessionError, session]);
  if (["/add-account", "/reset-password"].includes(pathname)) return undefined;
  const saved = offline.workspace;
  const local =
    saved &&
    saved.key === activeOfflineKey() &&
    (!user ||
      (saved.scope.userId === user.id &&
        saved.scope.organizationId === organizationId))
      ? saved
      : undefined;
  if (
    (!offline.online || sessionError) &&
    local &&
    (pathname === "/offline" || !session || sessionError)
  ) {
    return (
      <OfflineWorkspacePage
        key={local.key}
        workspace={local}
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
