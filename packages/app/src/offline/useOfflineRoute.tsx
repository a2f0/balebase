import { useEffect, useMemo, useRef } from "react";
import { signingTokenForPath } from "../workspace/workspacePaths";
import { OfflineWorkspacePage } from "./OfflineWorkspacePage";
import { hydrateProjectForms } from "./offlineHydration";
import {
  activeOfflineKey,
  lockOfflineWorkspace,
  lockOtherOfflineWorkspace,
  type OfflineIdentity,
  type OfflineWorkspace,
  offlineAccessEpoch,
  offlineScopeKey,
} from "./offlineStore";
import { useOfflineWorkspace } from "./useOfflineWorkspace";

interface OfflineSession {
  user: { id: string; name: string; email: string };
  session?: { activeOrganizationId?: string | null | undefined };
}
interface Workspace {
  activeOrganizationId: string | undefined;
  organizations: { id: string; name: string }[];
}

/**
 * The offline page for this path, if any. It opens in the workspace shell
 * while signed in, and stands alone otherwise.
 */
export function useOfflineRoute(
  session: OfflineSession | null | undefined,
  workspace: Workspace,
  access: { memberRole: string | undefined; loadError: string | undefined },
  pathname: string,
  navigate: (path: string) => void,
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
    // An expired cookie pauses API access, not local editing. Explicit sign-out
    // locks in accountSessions; changing identities also locks cached work here.
    if (pathname === "/add-account") lockOfflineWorkspace();
    else if (session)
      lockOtherOfflineWorkspace(session.user.id, confirmedOrganizationId);
  }, [session, confirmedOrganizationId, pathname]);
  const excluded =
    ["/add-account", "/reset-password"].includes(pathname) ||
    Boolean(signingTokenForPath(pathname));
  // After the lock effect above, so an identity change locks before this
  // takes its access epoch in the same commit.
  useProjectFormHydration(excluded ? undefined : identity, offline.online);
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
  const page = offlinePage();
  return (
    page && {
      page,
      standalone: !session || Boolean(sessionError),
    }
  );

  function offlinePage() {
    if (excluded) return undefined;
    const saved = pathname === "/offline" || fallback ? local : undefined;
    const key =
      saved?.key ??
      (pathname === "/offline" && identity
        ? offlineScopeKey(identity.scope)
        : undefined);
    if (!key) return undefined;
    return (
      <OfflineWorkspacePage
        key={key}
        workspace={saved}
        identity={identity}
        online={offline.online}
        onNavigate={navigate}
        storageError={offline.error}
      />
    );
  }
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

/**
 * Downloads the forms of the person's projects after sign-in confirms their
 * account and organization, and again after a failure once the device
 * reconnects. Each confirmed identity takes the access epoch once, when it
 * appears: a sign-out or account switch that starts later stops its download
 * before it unlocks the device, and signing in again starts afresh.
 */
function useProjectFormHydration(
  identity: OfflineIdentity | undefined,
  online: boolean,
) {
  const attempt = useRef<{
    epoch: string;
    key: string;
    state: "idle" | "running" | "done";
  }>(undefined);
  useEffect(() => {
    const key = identity && offlineScopeKey(identity.scope);
    if (attempt.current?.key !== key)
      attempt.current = key
        ? { epoch: offlineAccessEpoch(), key, state: "idle" }
        : undefined;
    const current = attempt.current;
    if (!identity || !online || current?.state !== "idle") return;
    current.state = "running";
    hydrateProjectForms(identity, current.epoch).then(
      () => {
        current.state = "done";
      },
      (cause: unknown) => {
        // Retried when the device reconnects; Offline work also offers
        // these downloads by hand.
        current.state = "idle";
        console.warn(
          "Could not download project forms for offline work.",
          cause,
        );
      },
    );
  }, [identity, online]);
}
