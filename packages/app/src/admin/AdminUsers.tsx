import {
  Badge,
  type BadgeTone,
  Button,
  EmptyState,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type { AdminUser } from "@balebase/validators/adminUsers";
import { useCallback, useState } from "react";
import { formatRoles, hasRole } from "../organizations/organizationState";
import { api } from "../shared/apiClient";
import { countLabel, formatDate } from "../shared/labels";
import { useLoad } from "../shared/useLoad";
import { adminUserIdForPath, adminUserPath } from "../workspace/workspacePaths";
import { AdminDeletionMenu } from "./AdminDeletionMenu";
import { AdminIdentity } from "./AdminIdentity";
import { AdminUserHistory } from "./AdminUserHistory";
import { useAdminUserDeletion } from "./adminUserDeletion";
import { adminUserListQuery, adminUserPageSize } from "./adminUserList";

interface UserListing {
  total: number;
  users: AdminUser[];
}

/** Every account on the platform, or one person's platform history. */
export function AdminUsers({
  currentUserId,
  onNavigate,
  pathname,
}: {
  currentUserId?: string | undefined;
  onNavigate: (pathname: string) => void;
  pathname: string;
}) {
  const userId = adminUserIdForPath(pathname);
  return userId ? (
    <AdminUserHistory key={userId} onNavigate={onNavigate} userId={userId} />
  ) : (
    <AdminUserList currentUserId={currentUserId} onNavigate={onNavigate} />
  );
}

function AdminUserList({
  currentUserId,
  onNavigate,
}: {
  currentUserId: string | undefined;
  onNavigate: (pathname: string) => void;
}) {
  const [page, setPage] = useState(0);
  const {
    data: listing,
    error,
    loading: busy,
    reload,
    setData,
  } = useLoad<UserListing>(
    useCallback(() => api.adminUsers.list(adminUserListQuery(page)), [page]),
    "Could not load users.",
  );
  const loadUsers = () => {
    setData(undefined);
    void reload();
  };

  const lifecycle = useAdminUserDeletion(reload);

  return (
    <Page>
      <PageHeader
        actions={
          <Button
            busy={busy}
            disabled={lifecycle.userId !== undefined}
            icon="refresh"
            onClick={loadUsers}
          >
            {busy ? "Loading…" : "Refresh"}
          </Button>
        }
        description="Every account on the platform."
        eyebrow="Root Admin"
        title="Users"
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        {lifecycle.error && <Toast tone="danger">{lifecycle.error}</Toast>}
        {lifecycle.notice && <Toast tone="success">{lifecycle.notice}</Toast>}
        <UserSection
          busy={busy}
          hasError={Boolean(error)}
          currentUserId={currentUserId}
          lifecycle={lifecycle}
          listing={listing}
          onNavigate={onNavigate}
          onPageChange={setPage}
          page={page}
        />
      </PageBody>
    </Page>
  );
}

function UserSection({
  busy,
  currentUserId,
  hasError,
  listing,
  lifecycle,
  onNavigate,
  onPageChange,
  page,
}: {
  busy: boolean;
  currentUserId: string | undefined;
  hasError: boolean;
  listing?: UserListing | undefined;
  lifecycle: ReturnType<typeof useAdminUserDeletion>;
  onNavigate: (pathname: string) => void;
  onPageChange: (page: number) => void;
  page: number;
}) {
  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(listing?.total ?? 0, "account", "accounts")}
        </span>
      }
      title="All users"
    >
      {listing && listing.users.length > 0 ? (
        <div className="stack stackMd">
          <UserTable
            currentUserId={currentUserId}
            lifecycle={lifecycle}
            onNavigate={onNavigate}
            users={listing.users}
          />
          <Pagination
            disabled={lifecycle.userId !== undefined}
            onPageChange={onPageChange}
            page={page}
            total={listing.total}
          />
        </div>
      ) : hasError ? null : busy ? (
        <LoadingState label="Loading users…" />
      ) : (
        <EmptyState compact icon="organization" title="No users found." />
      )}
    </PageSection>
  );
}

function UserTable({
  currentUserId,
  users,
  lifecycle,
  onNavigate,
}: {
  currentUserId: string | undefined;
  users: AdminUser[];
  lifecycle: ReturnType<typeof useAdminUserDeletion>;
  onNavigate: (pathname: string) => void;
}) {
  return (
    <div className="tableWrap">
      <table className="table adminUsersTable">
        <thead>
          <tr>
            <th scope="col">User</th>
            <th scope="col">Status</th>
            <th scope="col">Role</th>
            <th scope="col">Joined</th>
            <th scope="col">Last active</th>
            <th scope="col">Deletion</th>
            <th scope="col">
              <span className="srOnly">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <UserRow
              currentUserId={currentUserId}
              key={user.id}
              lifecycle={lifecycle}
              onNavigate={onNavigate}
              user={user}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserRow({
  currentUserId,
  user,
  lifecycle,
  onNavigate,
}: {
  currentUserId: string | undefined;
  user: AdminUser;
  lifecycle: ReturnType<typeof useAdminUserDeletion>;
  onNavigate: (pathname: string) => void;
}) {
  const status = statusFor(user);
  const isAdmin = hasRole(user.role, "admin");
  return (
    <tr>
      <td>
        <AdminIdentity avatar detail={user.email} name={user.name} />
      </td>
      <td>
        <Badge dot tone={status.tone}>
          {status.label}
        </Badge>
      </td>
      <td>
        <RoleBadge role={user.role ?? "user"} />
      </td>
      <td className="adminDate tabular">{formatDate(user.createdAt)}</td>
      <td className="adminDate tabular">
        {user.lastActiveAt ? formatDate(user.lastActiveAt) : "Never"}
      </td>
      <td>
        <UserDeletionStatus user={user} />
      </td>
      <td className="adminActions">
        <AdminDeletionMenu
          busy={lifecycle.userId === user.id}
          deletionDisabled={!user.deletionRequestedAt && isAdmin}
          disabled={lifecycle.userId !== undefined}
          extraItems={[
            ...(isAdmin
              ? [
                  {
                    // Revoking your own access would lock you out.
                    disabled: user.id === currentUserId,
                    icon: "lock" as const,
                    id: "revoke-admin",
                    label: "Revoke root admin",
                    onSelect: () => void lifecycle.revokeAdmin(user),
                  },
                ]
              : []),
            {
              icon: "list",
              id: "history",
              label: "View history",
              onSelect: () => onNavigate(adminUserPath(user.id)),
            },
          ]}
          label={
            user.deletionRequestedAt ? "Cancel deletion" : "Mark for deletion"
          }
          name={user.email}
          onSelect={() => void lifecycle.update(user)}
          pending={Boolean(user.deletionRequestedAt)}
        />
      </td>
    </tr>
  );
}

function UserDeletionStatus({ user }: { user: AdminUser }) {
  if (!user.deletionRequestedAt) return <span className="textSubtle">—</span>;
  return (
    <div className="adminStatus">
      <Badge dot tone="danger">
        Pending deletion
      </Badge>
      <span className="textXs textSubtle tabular">
        Since {formatDate(user.deletionRequestedAt)}
      </span>
      <span className="textXs textSubtle">
        Marked by{" "}
        {user.deletionRequestedByEmail ??
          user.deletionRequestedByName ??
          "Not recorded"}
      </span>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  return (
    <Badge tone={hasRole(role, "admin") ? "info" : "neutral"}>
      {formatRoles(role)}
    </Badge>
  );
}

function Pagination({
  disabled,
  onPageChange,
  page,
  total,
}: {
  onPageChange: (page: number) => void;
  page: number;
  total: number;
  disabled: boolean;
}) {
  const start = page * adminUserPageSize + 1;
  const end = Math.min((page + 1) * adminUserPageSize, total);
  return (
    <nav aria-label="User pages" className="cluster clusterBetween">
      <span className="textSm textSubtle tabular">
        {start}–{end} of {total}
      </span>
      <div className="cluster">
        <Button
          disabled={disabled || page === 0}
          icon="arrowLeft"
          onClick={() => onPageChange(page - 1)}
          size="sm"
        >
          Previous
        </Button>
        <Button
          disabled={disabled || end >= total}
          iconEnd="arrowRight"
          onClick={() => onPageChange(page + 1)}
          size="sm"
        >
          Next
        </Button>
      </div>
    </nav>
  );
}

function statusFor(user: AdminUser): { label: string; tone: BadgeTone } {
  if (user.banned) return { label: "Banned", tone: "danger" };
  if (user.emailVerified) return { label: "Verified", tone: "success" };
  return { label: "Unverified", tone: "warning" };
}
