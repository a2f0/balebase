import type { AdminOrganization } from "@balebase/validators/adminOrganizations";
import type { AdminUser } from "@balebase/validators/adminUsers";
import { createRoot } from "react-dom/client";
import { AdminOrganizations } from "../src/admin/AdminOrganizations";
import { AdminUsers } from "../src/admin/AdminUsers";

// The last row of each table holds one unbroken long value per column.
const longEmail = `${"longmailbox".repeat(4)}@${"subdomain".repeat(3)}.example.com`;

const users: AdminUser[] = Array.from({ length: 4 }, (_, index) => ({
  banned: false,
  createdAt: "2026-09-01T09:00:00.000Z",
  deletionRequestedAt: index === 1 ? "2026-10-01T09:00:00.000Z" : null,
  deletionRequestedByEmail: index === 1 ? longEmail : null,
  deletionRequestedByName: index === 1 ? "Root Admin" : null,
  email:
    index === 3 ? longEmail : `jordan.alvarez-${index}@harborline.example.com`,
  emailVerified: index !== 2,
  id: `user-${index}`,
  lastActiveAt: index === 3 ? null : "2026-10-14T15:30:00.000Z",
  name: index === 3 ? "Bartholomew".repeat(4) : `Jordan Alvarez ${index}`,
  role: index === 0 ? "user, admin" : "user",
}));

const organizations: AdminOrganization[] = Array.from(
  { length: 4 },
  (_, index) => ({
    createdAt: "2026-09-01T09:00:00.000Z",
    deletedAt: index === 1 ? "2026-10-01T09:00:00.000Z" : null,
    deletedByEmail: index === 1 ? longEmail : null,
    deletedByName: index === 1 ? "Root Admin" : null,
    deletedByUserId: index === 1 ? "root" : null,
    id: `org-${index}`,
    memberCount: 12,
    name:
      index === 3
        ? "Harborlinepropertyservices".repeat(3)
        : `Harborline Property Services ${index}`,
    ownerEmail: index === 3 ? longEmail : "jordan@harborline.example.com",
    ownerName: "Jordan Alvarez",
    plaidItemCount: 2,
    slug: index === 3 ? "harborline".repeat(6) : `harborline-${index}`,
  }),
);

export function mount(element: HTMLElement, table: "organizations" | "users") {
  const respond = async (input: RequestInfo | URL) =>
    new URL(String(input)).pathname.includes("users")
      ? Response.json({ limit: 25, offset: 0, total: users.length, users })
      : Response.json({ organizations });
  window.fetch = Object.assign(respond, { preconnect: () => {} });
  createRoot(element).render(
    table === "users" ? (
      <AdminUsers onNavigate={() => {}} pathname="/root/users" />
    ) : (
      <AdminOrganizations onNavigate={() => {}} />
    ),
  );
}
