import { expect, it } from "bun:test";
import { applyMigrations, createTestDatabase } from "../testing/database";

it("marks each organization's starting Finance group as built in", () => {
  const database = createTestDatabase({ before: "0089", foreignKeys: false });
  const organization = database.query(
    `INSERT INTO organization (id, name, slug, createdAt)
     VALUES (?, ?, ?, ?)`,
  );
  const team = database.query(
    `INSERT INTO team (id, name, organizationId, memberCount, createdAt, updatedAt)
     VALUES (?, ?, ?, 0, ?, ?)`,
  );
  const finance = database.query(
    `INSERT INTO organization_group_capability (organization_id, team_id, capability)
     VALUES (?, ?, 'finance')`,
  );
  const add = (
    id: string,
    name: string,
    organizationId: string,
    createdAt: string,
    withFinance: boolean,
  ) => {
    team.run(id, name, organizationId, createdAt, createdAt);
    if (withFinance) finance.run(organizationId, id);
  };

  // Migration 0010's group, keyed by the organization.
  organization.run("legacy", "Legacy", "legacy", "2026-08-19T12:21:02.588Z");
  add(
    "team_finance_legacy",
    "Finance",
    "legacy",
    "2026-08-19T12:21:02.588Z",
    true,
  );
  // Sign-up's group, renamed since, beside a later group the owner made.
  organization.run("signup", "Signup", "signup", "2026-10-28T17:02:53.251Z");
  add("signup-finance", "Accounts", "signup", "2026-10-28T17:02:53.853Z", true);
  add("signup-later", "Finance", "signup", "2026-10-29T09:00:00.000Z", true);
  // A group made with the organization but without Finance access, and a
  // later Finance group: neither is the starting one.
  organization.run("other", "Other", "other", "2026-08-20T17:00:56.977Z");
  add("other-default", "Other", "other", "2026-08-20T17:00:57.104Z", false);
  add("other-ops", "Operations", "other", "2026-10-13T10:27:28.905Z", true);
  // Two candidates within the minute: only the earlier one is kept.
  organization.run("twice", "Twice", "twice", "2026-10-30T02:23:46.444Z");
  add("twice-first", "Finance", "twice", "2026-10-30T02:23:46.531Z", true);
  add("twice-second", "Finance 2", "twice", "2026-10-30T02:23:50.000Z", true);

  // Sign-up's group with its Finance access revoked: still named Finance.
  organization.run("revoked", "Revoked", "revoked", "2026-10-21T12:48:31.158Z");
  add(
    "revoked-finance",
    "Finance",
    "revoked",
    "2026-10-21T12:48:31.357Z",
    false,
  );
  // Revoked and renamed: its recorded creation granted Finance.
  organization.run("renamed", "Renamed", "renamed", "2026-10-23T11:51:38.494Z");
  add(
    "renamed-finance",
    "Payables",
    "renamed",
    "2026-10-23T11:51:38.575Z",
    false,
  );
  database
    .query(
      `INSERT INTO activity_events (organization_id, root_type, root_id,
         root_label, subject_type, subject_id, action, actor_user_id,
         actor_name, actor_email, occurred_at, details)
       VALUES ('renamed', 'organization_group', ?, 'Finance',
         'organization_group', ?, 'organization.group_created', 'owner',
         'Owner', 'owner@example.com', '2026-10-23T11:51:38.575Z', ?)`,
    )
    .run(
      "renamed-finance",
      "renamed-finance",
      JSON.stringify({
        capabilities: ["finance"],
        members: [],
        name: "Finance",
      }),
    );

  applyMigrations(database, { from: "0089" });

  expect(
    database
      .query(
        `SELECT team_id, organization_id, kind FROM organization_builtin_group
         ORDER BY organization_id`,
      )
      .all(),
  ).toEqual([
    {
      kind: "finance",
      organization_id: "legacy",
      team_id: "team_finance_legacy",
    },
    {
      kind: "finance",
      organization_id: "renamed",
      team_id: "renamed-finance",
    },
    {
      kind: "finance",
      organization_id: "revoked",
      team_id: "revoked-finance",
    },
    { kind: "finance", organization_id: "signup", team_id: "signup-finance" },
    { kind: "finance", organization_id: "twice", team_id: "twice-first" },
  ]);
});
