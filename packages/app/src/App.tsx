import {
  BrandMark,
  Button,
  EmptyState,
  Icon,
  Page,
  PageBody,
  PageHeader,
} from "@balebase/ui/react";
import { type ReactNode, useEffect, useState } from "react";
import {
  accountReturnPath,
  addAccountPath,
  invitationIdForPath,
  workspaceContentKey,
} from "./account/accountNavigation";
import { useAccountSessions } from "./account/accountSessions";
import { AuthPage } from "./auth/AuthPage";
import type { AuthenticationAction } from "./auth/authActions";
import { useSessionRefetch } from "./auth/useSessionRefetch";
import { Library } from "./Library";
import { useOfflineSlot } from "./offlineSlot";
import { useLinkedOrganization } from "./organizations/linkedOrganization";
import { OrganizationGate } from "./organizations/OrganizationGate";
import { hasRole } from "./organizations/organizationState";
import { useOrganizationAccess } from "./organizations/useOrganizationAccess";
import { SigningPage } from "./SigningPage";
import { authClient } from "./shared/authClient";
import { authCallbackUrl } from "./shared/config";
import { useOfflineRoute } from "./useOfflineRoute";
import {
  guardWorkspaceChange,
  useDismissDialogsOnWorkspaceChange,
  useWorkspaceNavigation,
} from "./workspace/navigationGuard";
import {
  type OrganizationSession,
  useWorkspaceOrganizations,
} from "./workspace/useWorkspaceOrganizations";
import { WorkspaceShell, type WorkspaceUser } from "./workspace/WorkspaceShell";
import {
  isRootAdminPath,
  isWithin,
  movedWorkspacePath,
  organizationPathRequiresAccess,
  signingTokenForPath,
} from "./workspace/workspacePaths";
import { workspaceRoute } from "./workspace/workspaceRoutes";

export function App() {
  const { data: session, error, isPending, refetch } = authClient.useSession();
  const sessionRefetch = useSessionRefetch(session, isPending, error, refetch);
  const [pathname, setPathname] = useState(initialPathname);
  const isAddAccountPage = pathname === "/add-account";
  const isResetPage = pathname === "/reset-password";
  const verification = verificationFeedback();
  const workspace = useWorkspaceOrganizations(session, () => refetch());
  useLinkedOrganization(workspace);
  const access = useOrganizationAccess(
    session?.user.id,
    workspace.activeOrganizationId,
  );
  const accounts = useAccountSessions(session, () => refetch());

  const navigate = useWorkspaceNavigation(setPathname);
  const offlineRoute = useOfflineRoute(
    session,
    workspace,
    access,
    pathname,
    navigate,
    error,
  );
  useDismissDialogsOnWorkspaceChange(session, workspace.activeOrganizationId);

  useEffect(() => {
    if (verification.shouldClear) {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname,
      );
    }
  }, [verification.shouldClear]);

  const offline = useOfflineSlot(offlineRoute?.page);
  return (
    <>
      {routeContent()}
      {offline.portal}
    </>
  );

  function routeContent() {
    // Signers open these from emailed links, signed in or not.
    const signingToken = signingTokenForPath(pathname);
    if (signingToken) return <SigningPage token={signingToken} />;

    if (offlineRoute?.standalone) return offline.slot;

    // The sign-in page stays through background refetches; see useSessionRefetch.
    const background = sessionRefetch.background && !session;
    if (isPending && !background) {
      return <LoadingScreen />;
    }

    if (error && !isResetPage && !background) {
      return <SessionError onRetry={() => void refetch()} />;
    }

    if (isAddAccountPage || isResetPage || !session) {
      return (
        <AuthenticationRoute
          activeSessionToken={session?.session.token}
          addingAccount={isAddAccountPage}
          leaveResetPage={(destination) => {
            // Replace, not push: Back must not return to the spent reset link.
            window.history.replaceState(window.history.state, "", destination);
            setPathname(destination);
          }}
          navigate={navigate}
          pathname={pathname}
          refetchSession={sessionRefetch.request}
          resettingPassword={isResetPage}
          sessionPresent={Boolean(session)}
          verification={verification}
        />
      );
    }

    return (
      <AuthenticatedWorkspace
        accounts={accounts}
        access={access}
        navigate={navigate}
        offlinePage={offline.slot}
        pathname={pathname}
        onSessionChanged={() => refetch()}
        session={session}
        verificationNotice={verification.notice}
        workspace={workspace}
      />
    );
  }
}

function AuthenticationRoute({
  activeSessionToken,
  addingAccount,
  leaveResetPage,
  navigate,
  pathname,
  refetchSession,
  resettingPassword,
  sessionPresent,
  verification,
}: {
  activeSessionToken: string | undefined;
  addingAccount: boolean;
  leaveResetPage: (destination: string) => void;
  navigate: (pathname: string) => void;
  pathname: string;
  refetchSession: () => Promise<unknown>;
  resettingPassword: boolean;
  sessionPresent: boolean;
  verification: ReturnType<typeof verificationFeedback>;
}) {
  const returnTo = accountReturnPath(
    window.location.search,
    window.location.href,
  );
  const invitationNotice =
    pathname === "/invite"
      ? "Sign in or create an account with the invited email address to continue."
      : verification.notice;
  return (
    <AuthPage
      initialError={verification.error}
      initialMode={resettingPassword ? "reset" : "sign-in"}
      initialNotice={
        addingAccount
          ? "Sign in to keep another account available on this browser."
          : invitationNotice
      }
      initialNoticeTone={
        !addingAccount && pathname !== "/invite" && verification.notice
          ? "success"
          : "info"
      }
      onAuthenticated={async (action: AuthenticationAction) => {
        const invitationId =
          action === "sign-up"
            ? invitationIdForPath(
                addingAccount ? returnTo : currentLocation(),
                window.location.href,
              )
            : undefined;
        if (invitationId) {
          const result = await authClient.organization.acceptInvitation({
            invitationId,
          });
          if (result.error) {
            await refetchSession();
            throw new Error(
              result.error.message ?? "Could not accept this invitation.",
            );
          }
        }
        await refetchSession();
        if (invitationId) {
          navigate("/organization");
        } else if (addingAccount) {
          navigate(returnTo);
        }
      }}
      onCancel={
        sessionPresent && addingAccount
          ? async () => {
              if (!activeSessionToken) return;
              const result = await authClient.multiSession.setActive({
                sessionToken: activeSessionToken,
              });
              if (result.error) {
                throw new Error(
                  result.error.message ?? "Could not return to your account.",
                );
              }
              await refetchSession();
              navigate(returnTo);
            }
          : undefined
      }
      onLeaveReset={async () => {
        // A reset revokes that account's sessions. A session that survives it,
        // or going back without resetting, keeps its account: sign-in then
        // adds the reset account beside it.
        if (sessionPresent && (await sessionSurvives())) {
          leaveResetPage("/add-account");
          return;
        }
        if (sessionPresent) await refetchSession();
        leaveResetPage("/");
      }}
      variant={addingAccount ? "add-account" : "default"}
    />
  );
}

interface AuthenticatedSession extends OrganizationSession {
  session: OrganizationSession["session"] & { token: string };
  user: WorkspaceUser & {
    defaultOrganizationId?: string | null | undefined;
    id: string;
  };
}

function AuthenticatedWorkspace({
  access,
  accounts,
  navigate,
  offlinePage,
  onSessionChanged,
  pathname,
  session,
  verificationNotice,
  workspace,
}: {
  access: ReturnType<typeof useOrganizationAccess>;
  accounts: ReturnType<typeof useAccountSessions>;
  navigate: (pathname: string) => void;
  offlinePage: ReactNode;
  onSessionChanged: () => Promise<unknown>;
  pathname: string;
  session: AuthenticatedSession;
  verificationNotice: string | undefined;
  workspace: ReturnType<typeof useWorkspaceOrganizations>;
}) {
  const blocked = blockedWorkspaceContent(
    access,
    navigate,
    pathname,
    session,
    workspace,
  );
  // Keep in-progress offline work visible while access loads.
  if (blocked && !offlinePage) return blocked;
  const library = (
    <Library
      initialNotice={verificationNotice}
      onNavigate={navigate}
      onResendVerification={() => resendVerification(session.user.email)}
      pathname={pathname}
      user={session.user}
    />
  );
  const contentKey = workspaceContentKey(
    pathname,
    session.user.id,
    workspace.activeOrganizationId,
  );
  const addAccount = () => navigate(addAccountPath(currentLocation()));
  const route = workspaceRoute(pathname);
  const hasWorkspace = workspace.organizations.length > 0;
  const showContent =
    hasWorkspace ||
    !organizationPathRequiresAccess(pathname) ||
    pathname === "/inbox";
  return (
    <WorkspaceShell
      accountLoadError={accounts.loadError}
      accounts={accounts.accounts}
      activePage={route.page}
      activeOrganizationId={workspace.activeOrganizationId}
      activeSessionToken={session.session.token}
      canAccessFinance={access.can("finance")}
      contentKey={contentKey}
      onAccountChange={guardWorkspaceChange(accounts.switchAccount)}
      onAccountSettings={() => navigate("/account")}
      onAddAccount={addAccount}
      onNavigate={navigate}
      onOrganizationCreate={guardWorkspaceChange(workspace.createOrganization)}
      onOrganizationChange={guardWorkspaceChange(workspace.switchOrganization)}
      onRefreshAccounts={accounts.refresh}
      onSignOut={guardWorkspaceChange(accounts.signOutActiveAccount)}
      organizations={workspace.organizations}
      user={session.user}
    >
      {/* Offline work checks its own access. */}
      {offlinePage ?? (
        <OrganizationGate
          access={access}
          navigate={navigate}
          pathname={pathname}
          signOut={guardWorkspaceChange(accounts.signOutActiveAccount)}
        >
          {showContent ? (
            route.render({
              access,
              addAccount,
              library,
              navigate,
              onSecurityChanged: async () => {
                await onSessionChanged();
                await access.refresh();
              },
              pathname,
              user: session.user,
              workspace,
            })
          ) : (
            <NoOrganization />
          )}
        </OrganizationGate>
      )}
    </WorkspaceShell>
  );
}

/** A loading or access-denied screen when the path can't be shown yet. */
function blockedWorkspaceContent(
  access: ReturnType<typeof useOrganizationAccess>,
  navigate: (pathname: string) => void,
  pathname: string,
  session: AuthenticatedSession,
  workspace: ReturnType<typeof useWorkspaceOrganizations>,
) {
  if (workspace.isPending) return <LoadingScreen />;
  if (isRootAdminPath(pathname) && !hasRole(session.user.role, "admin")) {
    return <AdminAccessDenied onNavigate={() => navigate("/")} />;
  }
  if (organizationPathRequiresAccess(pathname) && access.isPending) {
    return <LoadingScreen />;
  }
  if (
    isWithin(pathname, "/finance") &&
    !access.twoFactorRequirement &&
    !access.seatRequirement &&
    !access.can("finance")
  ) {
    return <FeatureAccessDenied onNavigate={() => navigate("/")} />;
  }
  return undefined;
}

function NoOrganization() {
  return (
    <Page narrow>
      <PageHeader eyebrow="Workspace" title="Create an organization" />
      <PageBody>
        <EmptyState
          icon="organization"
          title="You don’t have an active organization"
        >
          Use the organization control in the sidebar to create one.
        </EmptyState>
      </PageBody>
    </Page>
  );
}

async function resendVerification(email: string) {
  const result = await authClient.sendVerificationEmail({
    callbackURL: authCallbackUrl("/?verified=true"),
    email,
  });
  if (result.error) {
    throw new Error(
      result.error.message ?? "Could not send verification email.",
    );
  }
}

/**
 * The path to open, moving an older link to where it now lives. The address
 * bar is updated in place, so Back does not return to the old address.
 */
function initialPathname() {
  const moved = movedWorkspacePath(window.location.pathname);
  if (!moved) return window.location.pathname;
  window.history.replaceState(
    window.history.state,
    "",
    `${moved}${window.location.search}${window.location.hash}`,
  );
  return moved;
}

function currentLocation() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function AdminAccessDenied({ onNavigate }: { onNavigate: () => void }) {
  return (
    <FatalState
      action="Return to your library"
      message="Administrator access is required."
      onAction={onNavigate}
    />
  );
}

function FeatureAccessDenied({ onNavigate }: { onNavigate: () => void }) {
  return (
    <FatalState
      action="Return to your library"
      message="Finance group membership is required."
      onAction={onNavigate}
    />
  );
}

/** Whether this browser still has a session; false when that is unknown. */
async function sessionSurvives() {
  try {
    const { data } = await authClient.getSession();
    return Boolean(data);
  } catch {
    // Unreachable: the refetch that follows reports it as a session error.
    return false;
  }
}

function SessionError({ onRetry }: { onRetry: () => void }) {
  return (
    <FatalState
      action="Try again"
      message="We couldn’t load your session."
      onAction={onRetry}
    />
  );
}

function FatalState({
  action,
  message,
  onAction,
}: {
  action: string;
  message: string;
  onAction: () => void;
}) {
  return (
    <div className="fatalState">
      <div className="card fatalCard">
        <span className="emptyStateIcon">
          <Icon name="alert" size={22} />
        </span>
        <h1 className="cardTitle">{message}</h1>
        <Button onClick={onAction} variant="primary">
          {action}
        </Button>
      </div>
    </div>
  );
}

function verificationFeedback() {
  const parameters = new URLSearchParams(window.location.search);
  if (parameters.get("verified") !== "true") {
    return { shouldClear: false };
  }

  if (parameters.has("error")) {
    return {
      error:
        "That verification link is invalid or expired. Request a new one after signing in.",
      shouldClear: true,
    };
  }

  return {
    notice: "Email verified. Thanks for confirming your address.",
    shouldClear: true,
  };
}

function LoadingScreen() {
  return (
    <div className="loadingScreen onDark" role="status">
      <span className="srOnly">Loading session</span>
      <BrandMark className="loadingMark" />
    </div>
  );
}
