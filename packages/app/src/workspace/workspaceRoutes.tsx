import type { ReactNode } from "react";
import { AccountSettings } from "../account/AccountSettings";
import { Activity } from "../activity/Activity";
import { AdminGlobalAudits } from "../admin/AdminGlobalAudits";
import { AdminJobs } from "../admin/AdminJobs";
import { AdminOrganizations } from "../admin/AdminOrganizations";
import { AdminUsers } from "../admin/AdminUsers";
import { Audits } from "../audits/Audits";
import { Businesses } from "../businesses/Businesses";
import { Contracts } from "../contracts/Contracts";
import { MyDocuments } from "../employeeForms/MyDocuments";
import { Equipment } from "../equipment/Equipment";
import { Finance } from "../finance/Finance";
import { FinanceAccountPage } from "../finance/FinanceAccountPage";
import { FinanceConnectionPage } from "../finance/FinanceConnectionPage";
import { FinanceTransactionPage } from "../finance/FinanceTransactionPage";
import { Inbox } from "../inbox/Inbox";
import { Issues } from "../issues/Issues";
import { OrganizationInvitation } from "../organizations/OrganizationInvitation";
import { OrganizationSettings } from "../organizations/OrganizationSettings";
import type { WorkspaceOrganization } from "../organizations/organizationState";
import type { useOrganizationAccess } from "../organizations/useOrganizationAccess";
import type { WorkspacePage } from "./WorkspaceShell";
import {
  adminOrganizationPath,
  globalAuditsPath,
  isWithin,
  recordIdForPath,
} from "./workspacePaths";

/** What a workspace page can use from the signed-in shell around it. */
interface RouteContext {
  access: ReturnType<typeof useOrganizationAccess>;
  addAccount: () => void;
  library: ReactNode;
  navigate: (pathname: string) => void;
  onSecurityChanged: () => Promise<unknown>;
  pathname: string;
  user: {
    defaultOrganizationId?: string | null | undefined;
    twoFactorEnabled?: boolean | null | undefined;
  };
  workspace: {
    activeOrganizationId: string | undefined;
    organizations: WorkspaceOrganization[];
    refresh: () => Promise<void>;
  };
}

interface WorkspaceRoute {
  matches: (pathname: string) => boolean;
  /** The sidebar entry marked current. */
  page: WorkspacePage;
  render: (context: RouteContext) => ReactNode;
}

const within = (base: string) => (pathname: string) => isWithin(pathname, base);
const exactly =
  (...paths: string[]) =>
  (pathname: string) =>
    paths.includes(pathname);

const routes: WorkspaceRoute[] = [
  {
    matches: within("/issues"),
    page: "issues",
    render: ({ access, navigate, pathname }) => (
      <Issues
        canAccessFinance={access.can("finance")}
        onNavigate={navigate}
        pathname={pathname}
      />
    ),
  },
  {
    matches: exactly("/activity"),
    page: "activity",
    render: ({ access, navigate }) => (
      <Activity
        canAccessFinance={access.can("finance")}
        onNavigate={navigate}
      />
    ),
  },
  // The offline slot replaces this whenever this device has offline work.
  {
    matches: exactly("/offline"),
    page: "offline",
    render: ({ library }) => library,
  },
  {
    matches: within("/audits"),
    page: "audits",
    render: ({ navigate, pathname }) => (
      <Audits onNavigate={navigate} pathname={pathname} />
    ),
  },
  {
    matches: within("/me"),
    page: "myDocuments",
    render: ({ navigate, pathname, workspace }) => (
      <MyDocuments
        onNavigate={navigate}
        organization={workspace.organizations.find(
          ({ id }) => id === workspace.activeOrganizationId,
        )}
        pathname={pathname}
      />
    ),
  },
  {
    matches: within("/finance"),
    page: "finance",
    render: ({ navigate, pathname }) => financeContent(pathname, navigate),
  },
  {
    matches: within("/businesses"),
    page: "businesses",
    render: ({ navigate, pathname }) => (
      <Businesses onNavigate={navigate} pathname={pathname} />
    ),
  },
  {
    matches: within("/contracts"),
    page: "contracts",
    render: ({ navigate, pathname }) => (
      <Contracts onNavigate={navigate} pathname={pathname} />
    ),
  },
  {
    matches: within("/equipment"),
    page: "equipment",
    render: ({ navigate, pathname }) => (
      <Equipment onNavigate={navigate} pathname={pathname} />
    ),
  },
  {
    matches: exactly("/inbox"),
    page: "inbox",
    render: ({ access, navigate }) => (
      <Inbox canAccessFinance={access.can("finance")} onNavigate={navigate} />
    ),
  },
  {
    matches: exactly("/root/jobs"),
    page: "rootJobs",
    render: () => <AdminJobs />,
  },
  {
    matches: exactly("/root/users"),
    page: "rootUsers",
    render: () => <AdminUsers />,
  },
  {
    matches: within(globalAuditsPath()),
    page: "rootGlobalAudits",
    render: ({ navigate, pathname }) => (
      <AdminGlobalAudits onNavigate={navigate} pathname={pathname} />
    ),
  },
  {
    matches: within(adminOrganizationPath()),
    page: "rootOrganizations",
    render: ({ navigate, pathname }) => (
      <AdminOrganizations onNavigate={navigate} pathname={pathname} />
    ),
  },
  {
    matches: exactly("/account", "/account/security"),
    page: "account",
    render: ({ navigate, onSecurityChanged, pathname, user, workspace }) => (
      <AccountSettings
        defaultOrganizationId={user.defaultOrganizationId}
        onNavigate={navigate}
        onSessionChanged={onSecurityChanged}
        organizations={workspace.organizations}
        pathname={pathname}
        twoFactorEnabled={Boolean(user.twoFactorEnabled)}
      />
    ),
  },
  {
    matches: within("/organization"),
    page: "organization",
    render: ({ access, navigate, pathname, workspace }) => (
      <OrganizationSettings
        activeOrganizationId={workspace.activeOrganizationId}
        accessError={access.loadError}
        memberRole={access.memberRole}
        onAccessChanged={access.refresh}
        onNavigate={navigate}
        onWorkspaceChanged={workspace.refresh}
        organizations={workspace.organizations}
        ownerCount={access.ownerCount}
        pathname={pathname}
      />
    ),
  },
  {
    matches: exactly("/invite"),
    page: "organization",
    render: ({ addAccount, navigate, workspace }) => (
      <OrganizationInvitation
        invitationId={new URLSearchParams(window.location.search).get("id")}
        onAccepted={workspace.refresh}
        onNavigate={() => navigate("/organization")}
        onUseAnotherAccount={addAccount}
      />
    ),
  },
];

const libraryRoute: WorkspaceRoute = {
  matches: () => true,
  page: "library",
  render: ({ library }) => library,
};

/** The page that shows a workspace path; any other path opens the library. */
export function workspaceRoute(pathname: string) {
  return routes.find((route) => route.matches(pathname)) ?? libraryRoute;
}

function financeContent(pathname: string, navigate: (path: string) => void) {
  const accountId = recordIdForPath(pathname, "/finance/accounts");
  if (accountId)
    return (
      <FinanceAccountPage key={pathname} id={accountId} onNavigate={navigate} />
    );
  const connectionId = recordIdForPath(pathname, "/finance/connections");
  if (connectionId)
    return (
      <FinanceConnectionPage
        key={pathname}
        id={connectionId}
        onNavigate={navigate}
      />
    );
  const transactionId = recordIdForPath(pathname, "/finance/transactions");
  if (transactionId)
    return (
      <FinanceTransactionPage
        key={pathname}
        id={transactionId}
        onNavigate={navigate}
      />
    );
  return <Finance onNavigate={navigate} pathname={pathname} />;
}
