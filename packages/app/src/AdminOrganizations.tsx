import {
  Badge,
  Button,
  confirmDialog,
  EmptyState,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type { AdminOrganization } from "@balebase/validators/adminOrganizations";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useState,
} from "react";
import { AdminDeletionMenu } from "./AdminDeletionMenu";
import { AdminIdentity } from "./AdminIdentity";
import { AdminOrganizationDetails } from "./AdminOrganizationDetails";
import { AppLink } from "./shared/AppLink";
import { api } from "./shared/apiClient";
import { countLabel, formatDate } from "./shared/labels";
import { useAction } from "./shared/useAction";
import { useLoad } from "./shared/useLoad";
import {
  adminOrganizationIdForPath,
  adminOrganizationPath,
} from "./workspace/workspacePaths";

interface AdminOrganizationAction {
  organizationId: string;
  type: "delete" | "restore";
}

interface OrganizationActions {
  action: AdminOrganizationAction | undefined;
  onMarkForDeletion: (organization: AdminOrganization) => Promise<void>;
  onRestore: (organization: AdminOrganization) => Promise<void>;
}

interface OrganizationTableActions extends OrganizationActions {
  onNavigate: (pathname: string) => void;
}

export function AdminOrganizations({
  onNavigate,
  pathname = adminOrganizationPath(),
}: {
  onNavigate: (pathname: string) => void;
  pathname?: string | undefined;
}) {
  const organizationId = adminOrganizationIdForPath(pathname);
  return organizationId ? (
    <AdminOrganizationDetails
      key={organizationId}
      onNavigate={onNavigate}
      organizationId={organizationId}
    />
  ) : (
    <AdminOrganizationList onNavigate={onNavigate} />
  );
}

function AdminOrganizationList({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const {
    data: organizations,
    error,
    loading: busy,
    reload,
    setData: setOrganizations,
  } = useLoad(
    useCallback(() => api.adminOrganizations.list(), []),
    "Could not load organizations.",
  );
  const lifecycle = useAdminOrganizationLifecycle(setOrganizations);
  const loadOrganizations = () => {
    setOrganizations(undefined);
    void reload();
  };

  return (
    <Page>
      <PageHeader
        actions={
          <Button busy={busy} icon="refresh" onClick={loadOrganizations}>
            {busy ? "Loading…" : "Refresh"}
          </Button>
        }
        description="Every organization on the platform."
        eyebrow="Root Admin"
        title="Organizations"
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        {lifecycle.error && <Toast tone="danger">{lifecycle.error}</Toast>}
        {lifecycle.notice && <Toast tone="success">{lifecycle.notice}</Toast>}
        <OrganizationSection
          action={lifecycle.action}
          busy={busy}
          onMarkForDeletion={lifecycle.markForDeletion}
          onNavigate={onNavigate}
          onRestore={lifecycle.restore}
          organizations={organizations}
        />
      </PageBody>
    </Page>
  );
}

function useAdminOrganizationLifecycle(
  setOrganizations: Dispatch<SetStateAction<AdminOrganization[] | undefined>>,
) {
  const [action, setAction] = useState<AdminOrganizationAction>();
  const { error, notice, run } = useAction(
    "Could not update the organization.",
  );

  async function update(
    next: AdminOrganizationAction,
    change: () => Promise<Partial<AdminOrganization>>,
    success: string,
  ) {
    setAction(next);
    await run(async () => {
      const changed = await change();
      setOrganizations((current) =>
        current?.map((item) =>
          item.id === next.organizationId ? { ...item, ...changed } : item,
        ),
      );
    }, success);
    setAction(undefined);
  }

  const markForDeletion = async (organization: AdminOrganization) => {
    if (!(await confirmMarkForDeletion(organization))) return;
    await update(
      { organizationId: organization.id, type: "delete" },
      async () => {
        const deletion = await api.adminOrganizations.markForDeletion(
          organization.id,
        );
        return {
          deletedAt: deletion.deletedAt,
          deletedByEmail: deletion.deletedByEmail,
          deletedByName: deletion.deletedByName,
          deletedByUserId: deletion.deletedByUserId,
        };
      },
      `${organization.name} was marked for deletion.`,
    );
  };

  const restore = async (organization: AdminOrganization) => {
    if (!(await confirmRestore(organization))) return;
    await update(
      { organizationId: organization.id, type: "restore" },
      async () => {
        await api.adminOrganizations.restore(organization.id);
        return {
          deletedAt: null,
          deletedByEmail: null,
          deletedByName: null,
          deletedByUserId: null,
        };
      },
      `${organization.name} was restored.`,
    );
  };

  return { action, error, markForDeletion, notice, restore };
}

function OrganizationSection({
  action,
  busy,
  onMarkForDeletion,
  onNavigate,
  onRestore,
  organizations,
}: OrganizationTableActions & {
  busy: boolean;
  organizations?: AdminOrganization[] | undefined;
}) {
  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(
            organizations?.length ?? 0,
            "organization",
            "organizations",
          )}
        </span>
      }
      title="All organizations"
    >
      {organizations && organizations.length > 0 ? (
        <OrganizationTable
          action={action}
          onMarkForDeletion={onMarkForDeletion}
          onNavigate={onNavigate}
          onRestore={onRestore}
          organizations={organizations}
        />
      ) : organizations ? (
        <EmptyState
          compact
          icon="organization"
          title="No organizations found."
        />
      ) : busy ? (
        <LoadingState label="Loading organizations…" />
      ) : null}
    </PageSection>
  );
}

function OrganizationTable({
  action,
  onMarkForDeletion,
  onNavigate,
  onRestore,
  organizations,
}: OrganizationTableActions & { organizations: AdminOrganization[] }) {
  return (
    <div className="tableWrap">
      <table className="table adminOrganizationTable">
        <thead>
          <tr>
            <th scope="col">Organization</th>
            <th scope="col">Owner</th>
            <th className="adminNumeric" scope="col">
              Members
            </th>
            <th
              className="adminNumeric"
              scope="col"
              title="Bank login connections, including those with sync errors. Disconnected items are excluded."
            >
              Plaid items
            </th>
            <th scope="col">Status</th>
            <th scope="col">Marked by</th>
            <th scope="col">Created</th>
            <th scope="col">
              <span className="srOnly">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {organizations.map((organization) => (
            <OrganizationTableRow
              action={action}
              key={organization.id}
              onMarkForDeletion={onMarkForDeletion}
              onNavigate={onNavigate}
              onRestore={onRestore}
              organization={organization}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrganizationTableRow({
  action,
  onMarkForDeletion,
  onNavigate,
  onRestore,
  organization,
}: OrganizationTableActions & { organization: AdminOrganization }) {
  return (
    <tr>
      <td>
        <div className="adminIdentityText adminOrganization">
          <AppLink
            className="adminOrganizationName adminOrganizationLink"
            href={adminOrganizationPath(organization.id)}
            onNavigate={onNavigate}
          >
            {organization.name}
          </AppLink>
          <span className="adminSlug mono">{organization.slug}</span>
        </div>
      </td>
      <td>
        {organization.ownerName || organization.ownerEmail ? (
          <AdminIdentity
            detail={
              organization.ownerName
                ? (organization.ownerEmail ?? undefined)
                : undefined
            }
            name={organization.ownerName || organization.ownerEmail || ""}
          />
        ) : (
          <span className="textSubtle">No default owner</span>
        )}
      </td>
      <td className="adminNumeric tabular">{organization.memberCount}</td>
      <td className="adminNumeric tabular">{organization.plaidItemCount}</td>
      <td>
        <OrganizationStatus deletedAt={organization.deletedAt} />
      </td>
      <td>
        <DeletedBy organization={organization} />
      </td>
      <td className="adminDate tabular">
        {formatDate(organization.createdAt)}
      </td>
      <td className="adminActions">
        <OrganizationActionMenu
          action={action}
          onMarkForDeletion={onMarkForDeletion}
          onRestore={onRestore}
          organization={organization}
        />
      </td>
    </tr>
  );
}

function OrganizationStatus({
  deletedAt,
}: {
  deletedAt: AdminOrganization["deletedAt"];
}) {
  if (!deletedAt) {
    return (
      <Badge dot tone="success">
        Active
      </Badge>
    );
  }
  return (
    <div className="adminStatus">
      <Badge dot tone="danger">
        Pending deletion
      </Badge>
      <span className="textXs textSubtle tabular">
        Since {formatDate(deletedAt)}
      </span>
    </div>
  );
}

function DeletedBy({ organization }: { organization: AdminOrganization }) {
  if (!organization.deletedAt) {
    return <span className="textSubtle">—</span>;
  }
  return (
    <AdminIdentity
      detail={
        organization.deletedByEmail ??
        organization.deletedByUserId ??
        "Not recorded"
      }
      name={organization.deletedByName ?? "Unknown"}
    />
  );
}

function OrganizationActionMenu({
  action,
  onMarkForDeletion,
  onRestore,
  organization,
}: OrganizationActions & { organization: AdminOrganization }) {
  const pending = Boolean(organization.deletedAt);
  return (
    <AdminDeletionMenu
      busy={action?.organizationId === organization.id}
      disabled={action !== undefined}
      label={pending ? "Restore" : "Mark for deletion"}
      name={organization.name}
      onSelect={() =>
        void (pending ? onRestore : onMarkForDeletion)(organization)
      }
      pending={pending}
    />
  );
}

function confirmMarkForDeletion(organization: AdminOrganization) {
  return confirmDialog({
    confirmLabel: "Mark for deletion",
    message:
      "It will become unavailable immediately, and its data can be permanently purged after 30 days.",
    title: `Mark ${organization.name} for deletion?`,
    tone: "danger",
    typeToConfirm: organization.name,
  });
}

function confirmRestore(organization: AdminOrganization) {
  return confirmDialog({
    confirmLabel: "Restore",
    message:
      "Existing members who do not have another default organization will regain access.",
    title: `Restore ${organization.name}?`,
  });
}
