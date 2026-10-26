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
import { useCallback, useEffect, useState } from "react";
import { AdminDeletionMenu } from "./AdminDeletionMenu";
import { formatDate, Identity } from "./adminDisplay";
import { useAdminUserDeletion } from "./adminUserDeletion";
import { adminUserListQuery, adminUserPageSize } from "./adminUserList";
import { api } from "./apiClient";
import { countLabel } from "./labels";

interface UserListing {
  total: number;
  users: AdminUser[];
}

export function AdminUsers() {
  const [listing, setListing] = useState<UserListing>();
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();

  const loadUsers = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    setListing(undefined);
    try {
      setListing(await api.adminUsers.list(adminUserListQuery(page)));
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }, [page]);

  const lifecycle = useAdminUserDeletion(loadUsers);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  return (
    <Page>
      <PageHeader
        actions={
          <Button
            busy={busy}
            disabled={lifecycle.userId !== undefined}
            icon="refresh"
            onClick={() => void loadUsers()}
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
          lifecycle={lifecycle}
          listing={listing}
          onPageChange={setPage}
          page={page}
        />
      </PageBody>
    </Page>
  );
}

function UserSection({
  busy,
  hasError,
  listing,
  lifecycle,
  onPageChange,
  page,
}: {
  busy: boolean;
  hasError: boolean;
  listing?: UserListing | undefined;
  lifecycle: ReturnType<typeof useAdminUserDeletion>;
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
          <UserTable lifecycle={lifecycle} users={listing.users} />
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
  users,
  lifecycle,
}: {
  users: AdminUser[];
  lifecycle: ReturnType<typeof useAdminUserDeletion>;
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
            <UserRow key={user.id} user={user} lifecycle={lifecycle} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserRow({
  user,
  lifecycle,
}: {
  user: AdminUser;
  lifecycle: ReturnType<typeof useAdminUserDeletion>;
}) {
  const status = statusFor(user);
  return (
    <tr>
      <td>
        <Identity avatar detail={user.email} name={user.name} />
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
          disabled={
            lifecycle.userId !== undefined ||
            (!user.deletionRequestedAt &&
              user.role.split(",").some((role) => role.trim() === "admin"))
          }
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
  const roles = role
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return (
    <Badge tone={roles.includes("admin") ? "info" : "neutral"}>
      {roles.map(capitalize).join(", ")}
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

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load users.";
}
