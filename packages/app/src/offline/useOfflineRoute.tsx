import { useEffect, useMemo, useRef } from "react";
import { DeviceProjects } from "../projects/DeviceProjects";
import { isOnline } from "../shared/network";
import {
  isWithin,
  projectAuditForPath,
  projectPath,
  signingTokenForPath,
} from "../workspace/workspacePaths";
import type { DeviceState } from "./offlineContext";
import { pullOfflineAudits, pullOfflineWorkspace } from "./offlinePull";
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
 * This device's workspace for the confirmed account and organization, kept
 * in sync while signed in, and the page that shows it when the path needs
 * one: an audit started on this device, or the device's projects while it is
 * offline or the session cannot be confirmed. The page opens in the
 * workspace shell while signed in, and stands alone otherwise.
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
  useDeviceSync(excluded ? undefined : identity, offline.online);
  const local = matchingWorkspace(
    offline.workspace,
    user,
    confirmedOrganizationId,
  );
  const unconfirmed = !session || Boolean(sessionError);
  // Only without a confirmed session: a signed-in page that loses coverage
  // stays as it is, so nothing typed into it is lost, and Projects falls
  // back to this copy itself when it cannot load.
  const fallback = Boolean(
    !excluded && local && (!offline.online || sessionError) && unconfirmed,
  );
  useEffect(() => {
    // Give a cold offline reopen the device's projects before account
    // revalidation begins, so reconnecting never replaces a local editor.
    if (fallback && !isWithin(pathname, projectPath())) navigate(projectPath());
  }, [fallback, pathname, navigate]);
  const device = useMemo<DeviceState>(
    () => ({ error: offline.error, online: offline.online, workspace: local }),
    [offline.error, offline.online, local],
  );
  const shown =
    !excluded && local && (fallback || projectAuditForPath(pathname));
  return {
    device,
    page: shown
      ? {
          page: (
            <DeviceProjects
              key={local.key}
              onNavigate={navigate}
              pathname={pathname}
            />
          ),
          standalone: unconfirmed,
        }
      : undefined,
  };
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
 * Syncs the person's projects and forms, and their shared audits, to this
 * device once sign-in confirms their account and organization, then
 * whenever the device reconnects or the app regains focus, and every minute
 * while online. Each confirmed identity takes the access epoch once, when it
 * appears: a sign-out or account switch that starts later stops its sync
 * before it unlocks the device, and signing in again starts afresh.
 */
function useDeviceSync(identity: OfflineIdentity | undefined, online: boolean) {
  const attempt = useRef<{ epoch: string; key: string; running: boolean }>(
    undefined,
  );
  useEffect(() => {
    const key = identity && offlineScopeKey(identity.scope);
    if (attempt.current?.key !== key)
      attempt.current = key
        ? { epoch: offlineAccessEpoch(), key, running: false }
        : undefined;
    const current = attempt.current;
    if (!identity || !online || !current) return;
    const pull = () => {
      if (current.running || !isOnline()) return;
      current.running = true;
      pullOfflineWorkspace(identity, current.epoch)
        .then(() => pullOfflineAudits(identity, current.epoch))
        .catch((cause: unknown) =>
          console.warn("Could not sync projects to this device.", cause),
        )
        .finally(() => {
          current.running = false;
        });
    };
    pull();
    window.addEventListener("focus", pull);
    const timer = window.setInterval(pull, 60_000);
    return () => {
      window.removeEventListener("focus", pull);
      window.clearInterval(timer);
    };
  }, [identity, online]);
}
