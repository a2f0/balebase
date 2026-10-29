import { projectsRoutes } from "@balebase/validators/projects";
import { type Context, Hono } from "hono";
import { projectFormFilter } from "../audits/auditTemplates";
import type { ApiEnv } from "../auth/apiEnv";
import {
  canManage,
  listMemberDirectory,
  requireManager,
} from "../organizations/organizationMembers";
import {
  activityBatch,
  activityStatement,
  findActivity,
} from "../shared/activity";
import { readBody, respond } from "../shared/respond";
import {
  findAvailableForm,
  findProject,
  findProjectRow,
  listAvailableForms,
  listProjects,
} from "./projectRecords";

type ProjectContext = Context<ApiEnv>;

const invalidProject =
  "Project details are invalid. Enter a name of at most 120 characters and a description of at most 1,000.";

// Every write is guarded by its project still belonging to the organization,
// in the same statement, so a concurrent deletion cannot slip past it.
const projectExists =
  "EXISTS (SELECT 1 FROM projects WHERE id = ? AND organization_id = ?)";

const projects = new Hono<ApiEnv>();

projects.get("/", async (context) =>
  respond(context, projectsRoutes.list, {
    canManage: canManage(context),
    projects: await listProjects(
      context.env.DB,
      context.get("organizationId"),
      userId(context),
    ),
  }),
);

projects.post("/", requireManager(), async (context) => {
  const input = await readBody(context, projectsRoutes.create, invalidProject);
  if (input instanceof Response) return input;
  const organizationId = context.get("organizationId");
  const database = context.env.DB;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await activityBatch(database, context.get("apiKey"), [
    database
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, description, created_by, created_at,
            updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        organizationId,
        input.name,
        input.description,
        userId(context),
        now,
        now,
      ),
    projectEvent(context, id, {
      action: "project.created",
      details: null,
      subject: { id, type: "project" },
    }),
  ]);
  return projectResponse(context, projectsRoutes.create, id, 201);
});

projects.get("/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const database = context.env.DB;
  const project = await findProject(
    database,
    organizationId,
    context.req.param("id"),
    userId(context),
  );
  if (!project) return projectNotFound(context);
  const [availableForms, directory] = await Promise.all([
    listAvailableForms(database, organizationId),
    listMemberDirectory(database, organizationId),
  ]);
  return respond(context, projectsRoutes.get, {
    availableForms,
    canManage: canManage(context),
    directory,
    project,
  });
});

projects.get("/:id/activity", async (context) => {
  const organizationId = context.get("organizationId");
  const project = await findProjectRow(
    context.env.DB,
    organizationId,
    context.req.param("id"),
    userId(context),
  );
  if (!project) return projectNotFound(context);
  const page = await findActivity(
    context.env.DB,
    organizationId,
    context.req.query("cursor"),
    { id: project.id, type: "project" },
  );
  return page
    ? respond(context, projectsRoutes.activity, page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});

// Saves only the fields sent, and only over the revision the editor loaded:
// an edit made from an older revision returns 409 instead of overwriting or
// misrecording a change it never saw.
projects.patch("/:id", requireManager(), async (context) => {
  const organizationId = context.get("organizationId");
  const database = context.env.DB;
  const existing = await findProjectRow(
    database,
    organizationId,
    context.req.param("id"),
    userId(context),
  );
  if (!existing) return projectNotFound(context);
  const input = await readBody(context, projectsRoutes.update, invalidProject);
  if (input instanceof Response) return input;
  if (input.expectedRevision !== existing.revision)
    return staleProject(context);
  const changes = (["name", "description"] as const).flatMap((field) =>
    input[field] === undefined || input[field] === existing[field]
      ? []
      : [{ after: input[field], before: existing[field], field }],
  );
  if (!changes.length)
    return projectResponse(context, projectsRoutes.update, existing.id);
  const name = input.name ?? existing.name;
  const now = new Date().toISOString();
  const asLoaded = "id = ? AND organization_id = ? AND revision = ?";
  const bindings = [existing.id, organizationId, existing.revision];
  // The event commits only with the update it describes.
  const [, update] = await activityBatch(database, context.get("apiKey"), [
    activityStatement(
      database,
      {
        action: "project.updated",
        actorId: userId(context),
        details: { changes },
        occurredAt: now,
        organizationId,
        root: { id: existing.id, label: name, type: "project" },
        subject: { id: existing.id, type: "project" },
      },
      { bindings, sql: `EXISTS (SELECT 1 FROM projects WHERE ${asLoaded})` },
    ),
    database
      .prepare(
        `UPDATE projects
         SET name = ?, description = ?, revision = revision + 1,
             updated_at = ?
         WHERE ${asLoaded}`,
      )
      .bind(name, input.description ?? existing.description, now, ...bindings),
  ]);
  if (update?.meta.changes === 0) return staleProject(context);
  return projectResponse(context, projectsRoutes.update, existing.id);
});

projects.delete("/:id", requireManager(), async (context) => {
  const organizationId = context.get("organizationId");
  const database = context.env.DB;
  const existing = await findProjectRow(
    database,
    organizationId,
    context.req.param("id"),
    userId(context),
  );
  if (!existing) return projectNotFound(context);
  // History outlives the project; purging the organization removes it. The
  // event snapshots the row this batch deletes.
  await activityBatch(database, context.get("apiKey"), [
    projectEvent(context, existing.id, {
      action: "project.deleted",
      details: null,
      subject: { id: existing.id, type: "project" },
    }),
    database
      .prepare("DELETE FROM projects WHERE id = ? AND organization_id = ?")
      .bind(existing.id, organizationId),
  ]);
  return context.body(null, 204);
});

projects.put("/:id/members/:userId", requireManager(), async (context) => {
  const organizationId = context.get("organizationId");
  const database = context.env.DB;
  const project = await findProjectRow(
    database,
    organizationId,
    context.req.param("id"),
    userId(context),
  );
  if (!project) return projectNotFound(context);
  const memberId = context.req.param("userId");
  const person = (await listMemberDirectory(database, organizationId)).find(
    (entry) => entry.id === memberId,
  );
  if (!person) return notOrganizationMember(context);
  const canJoin = {
    bindings: [project.id, organizationId, organizationId, memberId],
    sql: `${projectExists}
      AND EXISTS (SELECT 1 FROM member WHERE organizationId = ? AND userId = ?)`,
  };
  const [, inserted] = await activityBatch(database, context.get("apiKey"), [
    projectEvent(
      context,
      project.id,
      {
        action: "project.member_added",
        details: memberDetails(person),
        subject: { id: memberId, type: "user" },
      },
      {
        bindings: [...canJoin.bindings, project.id, memberId],
        sql: `${canJoin.sql} AND NOT EXISTS (
          SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?)`,
      },
    ),
    database
      .prepare(
        `INSERT INTO project_members
           (project_id, organization_id, user_id, added_by, added_at)
         SELECT ?, ?, ?, ?, ? WHERE ${canJoin.sql}
         ON CONFLICT (project_id, user_id) DO NOTHING`,
      )
      .bind(
        project.id,
        organizationId,
        memberId,
        userId(context),
        new Date().toISOString(),
        ...canJoin.bindings,
      ),
  ]);
  if (inserted?.meta.changes === 0) {
    const stillMember = (
      await listMemberDirectory(database, organizationId)
    ).some((entry) => entry.id === memberId);
    if (!stillMember) return notOrganizationMember(context);
  }
  return projectResponse(context, projectsRoutes.addMember, project.id);
});

projects.delete("/:id/members/:userId", requireManager(), async (context) => {
  const organizationId = context.get("organizationId");
  const database = context.env.DB;
  const project = await findProjectRow(
    database,
    organizationId,
    context.req.param("id"),
    userId(context),
  );
  if (!project) return projectNotFound(context);
  const memberId = context.req.param("userId");
  const person = await database
    .prepare("SELECT id, name, email FROM user WHERE id = ?")
    .bind(memberId)
    .first<{ email: string; id: string; name: string }>();
  if (person) {
    const membership = {
      bindings: [project.id, memberId],
      sql: "EXISTS (SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?)",
    };
    await activityBatch(database, context.get("apiKey"), [
      projectEvent(
        context,
        project.id,
        {
          action: "project.member_removed",
          details: memberDetails(person),
          subject: { id: memberId, type: "user" },
        },
        membership,
      ),
      database
        .prepare(
          "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
        )
        .bind(project.id, memberId),
    ]);
  }
  return projectResponse(context, projectsRoutes.removeMember, project.id);
});

projects.put("/:id/forms/:templateId", requireManager(), async (context) => {
  const organizationId = context.get("organizationId");
  const database = context.env.DB;
  const project = await findProjectRow(
    database,
    organizationId,
    context.req.param("id"),
    userId(context),
  );
  if (!project) return projectNotFound(context);
  const form = await findAvailableForm(
    database,
    organizationId,
    context.req.param("templateId"),
  );
  if (!form) return formNotFound(context);
  // The form must still be published and usable when this commits.
  const canEnable = {
    bindings: [project.id, organizationId, form.id, organizationId],
    sql: `${projectExists} AND EXISTS (
      SELECT 1 FROM audit_template_families AS family
      JOIN audit_template_versions AS version
        ON version.template_id = family.id
       AND version.version = family.current_version
      WHERE family.id = ? AND ${projectFormFilter()})`,
  };
  const [, inserted] = await activityBatch(database, context.get("apiKey"), [
    projectEvent(
      context,
      project.id,
      {
        action: "project.form_enabled",
        details: { templateId: form.id, title: form.name },
        subject: { id: form.id, type: "audit_template" },
      },
      {
        bindings: [...canEnable.bindings, project.id, form.id],
        sql: `${canEnable.sql} AND NOT EXISTS (
          SELECT 1 FROM project_audit_forms
          WHERE project_id = ? AND template_id = ?)`,
      },
    ),
    database
      .prepare(
        `INSERT INTO project_audit_forms
           (project_id, organization_id, template_id, added_by, added_at)
         SELECT ?, ?, ?, ?, ? WHERE ${canEnable.sql}
         ON CONFLICT (project_id, template_id) DO NOTHING`,
      )
      .bind(
        project.id,
        organizationId,
        form.id,
        userId(context),
        new Date().toISOString(),
        ...canEnable.bindings,
      ),
  ]);
  if (
    inserted?.meta.changes === 0 &&
    !(await findAvailableForm(database, organizationId, form.id))
  )
    return formNotFound(context);
  return projectResponse(context, projectsRoutes.enableForm, project.id);
});

projects.delete("/:id/forms/:templateId", requireManager(), async (context) => {
  const organizationId = context.get("organizationId");
  const database = context.env.DB;
  const project = await findProjectRow(
    database,
    organizationId,
    context.req.param("id"),
    userId(context),
  );
  if (!project) return projectNotFound(context);
  const templateId = context.req.param("templateId");
  // Named as the organization last saw it: an unpublished global form's
  // later drafts stay private to root admins.
  const form = await database
    .prepare(
      `SELECT family.id, (
         SELECT version.name FROM audit_template_versions AS version
         WHERE version.template_id = family.id
           AND (family.organization_id = ? OR version.status = 'published')
         ORDER BY version.version DESC LIMIT 1
       ) AS name
       FROM audit_template_families AS family
       WHERE family.id = ?
         AND (family.scope = 'global' OR family.organization_id = ?)`,
    )
    .bind(organizationId, templateId, organizationId)
    .first<{ id: string; name: string | null }>();
  if (form) {
    const enabled = {
      bindings: [project.id, templateId],
      sql: `EXISTS (SELECT 1 FROM project_audit_forms
                    WHERE project_id = ? AND template_id = ?)`,
    };
    await activityBatch(database, context.get("apiKey"), [
      projectEvent(
        context,
        project.id,
        {
          action: "project.form_disabled",
          details: { templateId, title: form.name ?? "" },
          subject: { id: templateId, type: "audit_template" },
        },
        enabled,
      ),
      database
        .prepare(
          "DELETE FROM project_audit_forms WHERE project_id = ? AND template_id = ?",
        )
        .bind(project.id, templateId),
    ]);
  }
  return projectResponse(context, projectsRoutes.disableForm, project.id);
});

async function projectResponse(
  context: ProjectContext,
  route:
    | typeof projectsRoutes.create
    | typeof projectsRoutes.update
    | typeof projectsRoutes.addMember
    | typeof projectsRoutes.removeMember
    | typeof projectsRoutes.enableForm
    | typeof projectsRoutes.disableForm,
  id: string,
  status?: 200 | 201,
) {
  const project = await findProject(
    context.env.DB,
    context.get("organizationId"),
    id,
    userId(context),
  );
  if (!project) return projectNotFound(context);
  return respond(context, route, { project }, status);
}

/**
 * Records a project event in the batch, labelled with the project's name as
 * the batch finds it, and only while the project exists and `condition`
 * holds. Null `details` snapshot the project's name and description.
 */
function projectEvent(
  context: ProjectContext,
  projectId: string,
  event: {
    action: string;
    details: Record<string, unknown> | null;
    subject: { id: string; type: string };
  },
  condition: { bindings: (string | number)[]; sql: string } = {
    bindings: [],
    sql: "1",
  },
) {
  const details = event.details
    ? "?"
    : "json_object('name', project.name, 'description', project.description)";
  return context.env.DB.prepare(
    `INSERT INTO activity_events (
       organization_id, root_type, root_id, root_label, subject_type,
       subject_id, action, actor_user_id, actor_name, actor_email,
       occurred_at, details
     )
     SELECT project.organization_id, 'project', project.id, project.name, ?, ?,
            ?, actor.id, actor.name, actor.email, ?, ${details}
     FROM projects AS project
     JOIN user AS actor ON actor.id = ?
     WHERE project.id = ? AND project.organization_id = ? AND (${condition.sql})`,
  ).bind(
    event.subject.type,
    event.subject.id,
    event.action,
    new Date().toISOString(),
    ...(event.details ? [JSON.stringify(event.details)] : []),
    userId(context),
    projectId,
    context.get("organizationId"),
    ...condition.bindings,
  );
}

function memberDetails(person: { email: string; id: string; name: string }) {
  return {
    userEmail: person.email,
    userId: person.id,
    userName: person.name,
  };
}

function userId(context: ProjectContext) {
  return context.get("authSession").user.id;
}

function projectNotFound(context: ProjectContext) {
  return context.json({ error: "Project not found." }, 404);
}

function staleProject(context: ProjectContext) {
  return context.json(
    { error: "This project changed. Reload it before saving." },
    409,
  );
}

function formNotFound(context: ProjectContext) {
  return context.json({ error: "Audit form not found." }, 404);
}

function notOrganizationMember(context: ProjectContext) {
  return context.json(
    { error: "Only organization members can join a project." },
    400,
  );
}

export { projects };
