import type { Database, SQLQueryBindings } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import type { Project, ProjectSummary } from "@balebase/validators/projects";
import { activity } from "../shared/activity";
import { testBindings } from "../testing/bindings";
import { queryHooks, toD1 } from "../testing/d1";
import { createTestDatabase } from "../testing/database";
import { requester } from "../testing/http";
import { seedMember, seedOrganization, seedUser } from "../testing/seed";
import { testApp } from "../testing/session";
import { projects } from "./projects";

const timestamp = "2026-10-01T12:00:00.000Z";
const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

interface Detail {
  availableForms: Array<{ id: string; name: string; scope: string }>;
  canManage: boolean;
  directory: Array<{ id: string }>;
  project: Project;
}

describe("projects", () => {
  it("lets managers create a project, add members, and turn audit forms on", async () => {
    const { as, events } = fixture();
    const owner = as("owner-user", "owner");

    const created = await owner<{ project: Project }>("POST", "/api/projects", {
      description: " North wing ",
      name: " Hospital renovation ",
    });
    expect(created.status).toBe(201);
    expect(created.body.project).toMatchObject({
      description: "North wing",
      formCount: 0,
      isMember: false,
      memberCount: 0,
      name: "Hospital renovation",
    });
    const id = created.body.project.id;

    const detail = await owner<Detail>("GET", `/api/projects/${id}`);
    expect(detail.body.canManage).toBe(true);
    // Published global forms and the organization's own; not other
    // organizations' forms or unpublished global ones. Migrations also seed
    // the starter library's global forms.
    const offered = detail.body.availableForms.map((form) => form.id);
    expect(offered).toContain("org-form");
    expect(offered).toContain("global-published");
    expect(offered).not.toContain("other-org-form");
    expect(offered).not.toContain("global-draft");
    expect(detail.body.directory.map((person) => person.id)).toEqual([
      "member-user",
      "owner-user",
    ]);

    for (const userId of ["member-user", "member-user"]) {
      const added = await owner<{ project: Project }>(
        "PUT",
        `/api/projects/${id}/members/${userId}`,
      );
      expect(added.status).toBe(200);
    }
    for (const form of ["org-form", "global-published"]) {
      expect(
        (await owner("PUT", `/api/projects/${id}/forms/${form}`)).status,
      ).toBe(200);
    }
    const project = (await owner<Detail>("GET", `/api/projects/${id}`)).body
      .project;
    expect(project.members.map((person) => person.id)).toEqual(["member-user"]);
    // By name, each at its current version.
    expect(project.forms.map((form) => [form.name, form.version])).toEqual([
      ["NFPA 70E", 1],
      ["Site walk v2", 2],
    ]);

    const listing = await as("member-user", "member")<{
      canManage: boolean;
      projects: ProjectSummary[];
    }>("GET", "/api/projects");
    expect(listing.body.canManage).toBe(false);
    expect(listing.body.projects).toEqual([
      expect.objectContaining({
        formCount: 2,
        id,
        isMember: true,
        memberCount: 1,
      }),
    ]);

    // A repeated add records one event.
    expect(events()).toEqual([
      {
        action: "project.created",
        actor: "owner-user",
        details: { description: "North wing", name: "Hospital renovation" },
        label: "Hospital renovation",
        subject: "project",
      },
      {
        action: "project.member_added",
        actor: "owner-user",
        details: {
          userEmail: "member-user@example.com",
          userId: "member-user",
          userName: "Member",
        },
        label: "Hospital renovation",
        subject: "user",
      },
      {
        action: "project.form_enabled",
        actor: "owner-user",
        details: { templateId: "org-form", title: "Site walk v2" },
        label: "Hospital renovation",
        subject: "audit_template",
      },
      {
        action: "project.form_enabled",
        actor: "owner-user",
        details: { templateId: "global-published", title: "NFPA 70E" },
        label: "Hospital renovation",
        subject: "audit_template",
      },
    ]);
    const history = await owner<{ events: Array<{ action: string }> }>(
      "GET",
      `/api/projects/${id}/activity`,
    );
    expect(history.body.events.map((event) => event.action)).toEqual([
      "project.form_enabled",
      "project.form_enabled",
      "project.member_added",
      "project.created",
    ]);
  });

  it("records edits, removals, and deletion with their previous values", async () => {
    const { as, events, run } = fixture();
    const owner = as("owner-user", "owner");
    const id = await createProject(owner);
    await owner("PUT", `/api/projects/${id}/members/member-user`);
    await owner("PUT", `/api/projects/${id}/forms/org-form`);

    const renamed = await owner<{ project: Project }>(
      "PATCH",
      `/api/projects/${id}`,
      { name: "Clinic renovation" },
    );
    expect(renamed.body.project).toMatchObject({
      description: "",
      name: "Clinic renovation",
    });
    // Saving the same values changes nothing and claims nothing.
    await owner("PATCH", `/api/projects/${id}`, { name: "Clinic renovation" });
    for (let attempt = 0; attempt < 2; attempt++) {
      await owner("DELETE", `/api/projects/${id}/members/member-user`);
      await owner("DELETE", `/api/projects/${id}/forms/org-form`);
    }
    expect(
      (await owner<Detail>("GET", `/api/projects/${id}`)).body.project,
    ).toMatchObject({ forms: [], members: [] });
    expect((await owner("DELETE", `/api/projects/${id}`)).status).toBe(204);
    expect((await owner("GET", `/api/projects/${id}`)).status).toBe(404);
    expect(run("SELECT COUNT(*) AS count FROM project_members").get()).toEqual({
      count: 0,
    });

    expect(events().slice(3)).toEqual([
      {
        action: "project.updated",
        actor: "owner-user",
        details: {
          changes: [
            {
              after: "Clinic renovation",
              before: "Hospital renovation",
              field: "name",
            },
          ],
        },
        label: "Clinic renovation",
        subject: "project",
      },
      expect.objectContaining({
        action: "project.member_removed",
        details: expect.objectContaining({ userId: "member-user" }),
        label: "Clinic renovation",
      }),
      expect.objectContaining({
        action: "project.form_disabled",
        details: { templateId: "org-form", title: "Site walk v2" },
      }),
      {
        action: "project.deleted",
        actor: "owner-user",
        details: { description: "", name: "Clinic renovation" },
        label: "Clinic renovation",
        subject: "project",
      },
    ]);
  });

  it("rejects an edit made over a concurrent change without recording it", async () => {
    const { as, events, hooks, run } = fixture();
    const owner = as("owner-user", "owner");
    const id = await createProject(owner);
    hooks.after("FROM projects AS project", () => {
      run("UPDATE projects SET name = 'Renamed elsewhere' WHERE id = ?").run(
        id,
      );
    });
    const stale = await owner("PATCH", `/api/projects/${id}`, {
      name: "Mine",
    });
    expect(stale.status).toBe(409);
    expect(run("SELECT name FROM projects").get()).toEqual({
      name: "Renamed elsewhere",
    });
    expect(events().map((event) => event.action)).toEqual(["project.created"]);
  });

  it("lets members read projects but only managers change them", async () => {
    const { as, events } = fixture();
    const owner = as("owner-user", "owner");
    const member = as("member-user", "member");
    const id = await createProject(owner);

    const detail = await member<Detail>("GET", `/api/projects/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.canManage).toBe(false);
    for (const [method, path, body] of [
      ["POST", "/api/projects", { name: "Mine" }],
      ["PATCH", `/api/projects/${id}`, { name: "Mine" }],
      ["PUT", `/api/projects/${id}/members/member-user`, undefined],
      ["DELETE", `/api/projects/${id}/members/member-user`, undefined],
      ["PUT", `/api/projects/${id}/forms/org-form`, undefined],
      ["DELETE", `/api/projects/${id}/forms/org-form`, undefined],
      ["DELETE", `/api/projects/${id}`, undefined],
    ] as const)
      expect((await member(method, path, body)).status).toBe(403);
    // Another organization cannot see or change the project.
    const other = as("other-user", "owner", "org-2");
    expect((await other("GET", `/api/projects/${id}`)).status).toBe(404);
    expect(
      (await other("PUT", `/api/projects/${id}/members/other-user`)).status,
    ).toBe(404);
    expect((await other("GET", `/api/projects/${id}/activity`)).status).toBe(
      404,
    );
    expect(events().map((event) => event.action)).toEqual(["project.created"]);
  });

  it("refuses people outside the organization and forms it cannot use", async () => {
    const { as, events } = fixture();
    const owner = as("owner-user", "owner");
    const id = await createProject(owner);
    expect(
      (await owner("PUT", `/api/projects/${id}/members/other-user`)).status,
    ).toBe(400);
    for (const form of ["other-org-form", "global-draft", "missing"])
      expect(
        (await owner("PUT", `/api/projects/${id}/forms/${form}`)).status,
      ).toBe(404);
    expect((await owner("POST", "/api/projects", { name: "  " })).status).toBe(
      400,
    );
    expect(events().map((event) => event.action)).toEqual(["project.created"]);
  });

  it("drops people from projects when they leave the organization", async () => {
    const { as, run } = fixture();
    const owner = as("owner-user", "owner");
    const id = await createProject(owner);
    await owner("PUT", `/api/projects/${id}/members/member-user`);
    run("DELETE FROM member WHERE userId = 'member-user'").run();
    expect(
      (await owner<Detail>("GET", `/api/projects/${id}`)).body.project.members,
    ).toEqual([]);
  });

  it("rolls the change back when its history cannot be recorded", async () => {
    const { as, run } = fixture();
    const owner = as("owner-user", "owner");
    const id = await createProject(owner);
    run(
      `CREATE TRIGGER refuse_activity BEFORE INSERT ON activity_events
       BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`,
    ).run();
    expect(
      (await owner("PUT", `/api/projects/${id}/members/member-user`)).status,
    ).toBe(500);
    expect(
      (await owner("POST", "/api/projects", { name: "Other" })).status,
    ).toBe(500);
    expect(run("SELECT COUNT(*) AS count FROM project_members").get()).toEqual({
      count: 0,
    });
    expect(run("SELECT COUNT(*) AS count FROM projects").get()).toEqual({
      count: 1,
    });
  });
});

async function createProject(
  request: ReturnType<ReturnType<typeof fixture>["as"]>,
) {
  const created = await request<{ project: Project }>("POST", "/api/projects", {
    name: "Hospital renovation",
  });
  return created.body.project.id;
}

function fixture() {
  const database = createTestDatabase();
  databases.push(database);
  seed(database);
  const hooks = queryHooks();
  const bindings = testBindings({ DB: toD1(database, hooks) });
  const routes = { "/api/activity": activity, "/api/projects": projects };
  const as = (userId: string, role: string, organizationId = "org-1") =>
    requester(
      testApp(routes, { organizationId, organizationRole: role, userId }),
      bindings,
    );
  const run = (query: string) => database.query(query);
  const events = () =>
    (
      database
        .query(
          `SELECT action, actor_user_id AS actor, details, root_label AS label,
                  subject_type AS subject
           FROM activity_events WHERE root_type = 'project' ORDER BY id`,
        )
        .all() as Array<{
        action: string;
        actor: string;
        details: string;
        label: string;
        subject: string;
      }>
    ).map((event) => ({
      ...event,
      details: JSON.parse(event.details) as unknown,
    }));
  return { as, database, events, hooks, run };
}

function seed(database: Database) {
  const run = (query: string, ...values: SQLQueryBindings[]) =>
    database.query(query).run(...values);
  for (const [id, name] of [
    ["owner-user", "Owner"],
    ["member-user", "Member"],
    ["other-user", "Other"],
  ] as const)
    seedUser(database, { createdAt: timestamp, id, name });
  for (const id of ["org-1", "org-2"])
    seedOrganization(database, { createdAt: timestamp, id });
  for (const [id, organizationId, userId, role] of [
    ["member-owner", "org-1", "owner-user", "owner"],
    ["member-member", "org-1", "member-user", "member"],
    ["member-other", "org-2", "other-user", "owner"],
  ] as const)
    seedMember(database, {
      createdAt: timestamp,
      id,
      organizationId,
      role,
      userId,
    });
  const forms: Array<
    [string, "global" | "organization", string | null, string, string, number]
  > = [
    ["org-form", "organization", "org-1", "Site walk v2", "draft", 2],
    ["other-org-form", "organization", "org-2", "Their form", "draft", 1],
    ["global-published", "global", null, "NFPA 70E", "published", 1],
    ["global-draft", "global", null, "Unreleased", "draft", 1],
  ];
  for (const [id, scope, organizationId, name, status, version] of forms) {
    run(
      `INSERT INTO audit_template_families
         (id, scope, organization_id, current_version, created_by, created_at,
          updated_at)
       VALUES (?, ?, ?, ?, 'owner-user', ?, ?)`,
      id,
      scope,
      organizationId,
      version,
      timestamp,
      timestamp,
    );
    run(
      `INSERT INTO audit_template_versions
         (id, template_id, version, name, description, definition, status,
          created_by, created_at)
       VALUES (?, ?, ?, ?, '', '{"version":1,"sections":[]}', ?, 'owner-user', ?)`,
      `${id}-v${version}`,
      id,
      version,
      name,
      status,
      timestamp,
    );
  }
}
