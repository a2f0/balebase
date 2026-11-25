import {
  type FormDefinition,
  type FormIssue,
  formsRoutes,
} from "@balebase/validators/forms";
import type { Issue } from "@balebase/validators/issues";
import { Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import {
  freeFormTemplateLimit,
  organizationPlanLimits,
} from "../billing/billingEntitlements";
import {
  type IssueRow,
  issueInsert,
  issueSelect,
  issueUpdate,
  toIssue,
} from "../issues/issueRecords";
import { canManage } from "../organizations/organizationMembers";
import {
  type ActivityActor,
  type ActivityRow,
  activityBatch,
  findActivity,
  formAnswerActivityStatement,
  requestActor,
  toFormAnswerActivity,
} from "../shared/activity";
import {
  cursorPage,
  decodeCursor,
  encodeCursor,
} from "../shared/cursorPagination";
import { readBody, readQuery, respond } from "../shared/respond";
import { answerColumns, savedAnswers, storedAnswers } from "./formAnswers";
import { allRequiredAnswered, parseResponses } from "./formDefinition";
import {
  type FormIssueImageRow,
  findFormIssueImages,
  toFormIssueImage,
} from "./formIssueImageRecords";
import { formIssueImageRemoval } from "./formIssueImageRemoval";
import { formIssueImages } from "./formIssueImages";
import { formRunDiscard } from "./formRunDiscard";
import {
  discardedFormError,
  type FormRow,
  type FormSummaryRow,
  findForm,
  findIssueForUpdate,
  formProjectColumns,
  formStatement,
  toForm,
  toFormSummary,
} from "./formRunRecords";
import {
  createTemplate,
  findTemplate,
  listTemplateVersions,
  positiveInteger,
  saveTemplateVersion,
  staleTemplateError,
  storedDefinition,
  type TemplateRow,
  type TemplateSaveInput,
  templateSummarySelect,
  toTemplate,
  toTemplateSummary,
  visibleTemplateFilter,
} from "./formTemplates";

const forms = new Hono<ApiEnv>();

interface MemberRow {
  email: string;
  id: string;
  name: string;
}

const formRunPageSize = 100;
forms.get("/templates", async (context) => {
  const organizationId = context.get("organizationId");
  // Counts only this organization's forms, global templates included.
  const result = await context.env.DB.prepare(
    `${templateSummarySelect("?")}
     WHERE ${visibleTemplateFilter()}
     ORDER BY family.updated_at DESC`,
  )
    .bind(organizationId, organizationId)
    .all<TemplateRow & { form_count: number }>();
  return respond(context, formsRoutes.listTemplates, {
    templates: result.results.map(toTemplateSummary),
  });
});

forms.post("/templates", async (context) => {
  const body = await readBody(
    context,
    formsRoutes.createTemplate,
    "A template name is required.",
  );
  if (body instanceof Response) return body;
  const organizationId = context.get("organizationId");
  const { formTemplates: templateLimit } = await organizationPlanLimits(
    context.env,
    organizationId,
  );
  const template = await createTemplate(context.env.DB, {
    actor: requestActor(context),
    name: body.name,
    organizationId,
    templateLimit,
  });
  if (!template) {
    return context.json(
      {
        code: "UPGRADE_REQUIRED",
        error: `The Free plan is limited to ${templateLimit} form templates. Upgrade to Pro for unlimited templates.`,
      },
      409,
    );
  }
  return respond(
    context,
    formsRoutes.createTemplate,
    { template: toTemplate(template) },
    201,
  );
});

forms.post("/templates/:id/copies", async (context) => {
  const source = await findTemplate(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
  );
  if (source?.scope !== "global") {
    return context.json({ error: "Global template not found." }, 404);
  }
  const input = await readBody(
    context,
    formsRoutes.copyTemplate,
    "The template definition is invalid.",
  );
  if (input instanceof Response) return input;
  if (
    input.expectedCurrentVersion !== undefined &&
    input.expectedCurrentVersion !== source.current_version
  ) {
    return context.json({ error: staleTemplateError }, 409);
  }
  const { sourceVersion = null, ...copy } = input;
  if (
    sourceVersion !== null &&
    !(await findTemplate(
      context.env.DB,
      context.get("organizationId"),
      source.id,
      sourceVersion,
    ))
  ) {
    return context.json({ error: "Template version not found." }, 404);
  }
  const saved = await copyGlobalTemplate(
    context.env.DB,
    context.get("organizationId"),
    requestActor(context),
    copy,
    { current: source, version: sourceVersion },
    (await organizationPlanLimits(context.env, context.get("organizationId")))
      .formTemplates,
  );
  if (saved === "stale") {
    return context.json({ error: staleTemplateError }, 409);
  }
  if (!saved) {
    return context.json(
      {
        code: "UPGRADE_REQUIRED",
        error: `The Free plan is limited to ${freeFormTemplateLimit} form templates. Upgrade to Pro for unlimited templates.`,
      },
      409,
    );
  }
  return respond(
    context,
    formsRoutes.copyTemplate,
    { template: toTemplate(saved) },
    201,
  );
});

forms.get("/templates/:id/versions", async (context) => {
  const template = await findTemplate(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
  );
  if (!template) return context.json({ error: "Template not found." }, 404);
  return respond(context, formsRoutes.templateVersions, {
    versions: await listTemplateVersions(
      context.env.DB,
      template.id,
      template.scope === "global",
    ),
  });
});

forms.get("/templates/:id/versions/:version", async (context) => {
  const version = positiveInteger(context.req.param("version"));
  if (!version)
    return context.json({ error: "Template version is invalid." }, 400);
  const template = await findTemplate(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
    version,
  );
  return template
    ? respond(context, formsRoutes.templateVersion, {
        template: toTemplate(template),
      })
    : context.json({ error: "Template version not found." }, 404);
});

forms.get("/templates/:id", async (context) => {
  const template = await findTemplate(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
  );
  return template
    ? respond(context, formsRoutes.getTemplate, {
        template: toTemplate(template),
      })
    : context.json({ error: "Template not found." }, 404);
});

forms.get("/templates/:id/activity", async (context) => {
  const organizationId = context.get("organizationId");
  const template = await findTemplate(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!template) return context.json({ error: "Template not found." }, 404);
  const page = await findActivity(
    context.env.DB,
    template.scope === "global" ? null : organizationId,
    context.req.query("cursor"),
    {
      id: template.id,
      type: "form_template",
      publishedTemplateOnly: template.scope === "global",
    },
  );
  return page
    ? respond(context, formsRoutes.templateActivity, page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});

forms.put("/templates/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const current = await findTemplate(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!current) return context.json({ error: "Template not found." }, 404);
  if (current.scope === "global") {
    return context.json(
      { error: "Global templates are managed from Global templates." },
      403,
    );
  }
  const body = await readBody(
    context,
    formsRoutes.updateTemplate,
    "The template definition is invalid.",
  );
  if (body instanceof Response) return body;
  const { status, ...input } = body;
  if (status !== undefined && !canManage(context)) {
    return context.json(
      {
        error: "Only organization managers can publish or unpublish templates.",
      },
      403,
    );
  }
  if (status === "unpublished" && current.status !== "published") {
    return context.json(
      { error: "Only published templates can be unpublished." },
      409,
    );
  }
  const saved = await saveTemplateVersion(
    context.env.DB,
    organizationId,
    current,
    requestActor(context),
    input,
    status,
  );
  return saved === "stale"
    ? context.json({ error: staleTemplateError }, 409)
    : respond(context, formsRoutes.updateTemplate, {
        template: toTemplate(saved),
      });
});

// A form starts for a project, from a template turned on for it that is still
// usable; both are checked again in the insert itself.
forms.post("/templates/:id/runs", async (context) => {
  const body = await readBody(
    context,
    formsRoutes.start,
    "Name the project to start the form for.",
  );
  if (body instanceof Response) return body;
  const organizationId = context.get("organizationId");
  const template = await findTemplate(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!template) return context.json({ error: "Template not found." }, 404);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const insert = context.env.DB.prepare(
    `INSERT INTO forms
     (id, organization_id, project_id, template_id, template_family_id,
      template_version_id, template_version, template_name, definition,
      responses, status, started_by, created_at, updated_at)
     SELECT ?, ?, project.id, NULL, ?, ?, ?, ?, ?, '{}', 'in_progress', ?, ?, ?
     FROM projects AS project
     JOIN project_form_templates AS enabled
       ON enabled.project_id = project.id AND enabled.template_id = ?
     WHERE project.id = ? AND project.organization_id = ?
       AND project.deleted_at IS NULL`,
  ).bind(
    id,
    organizationId,
    template.id,
    template.version_id,
    template.version,
    template.name,
    template.definition,
    context.get("authSession").user.id,
    now,
    now,
    template.id,
    body.projectId,
    organizationId,
  );
  const [inserted] = await activityBatch(
    context.env.DB,
    context.get("apiKey"),
    [insert],
  );
  if (!inserted?.meta.changes)
    return context.json(
      { error: "This template is not turned on for that project." },
      404,
    );
  return respond(context, formsRoutes.start, { formId: id }, 201);
});

forms.get("/runs", async (context) => {
  const query = readQuery(context, formsRoutes.listRuns, "Invalid form view.");
  if (query instanceof Response) return query;
  const cursor =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, 2048);
  if (query.cursor !== undefined && !cursor) {
    return context.json({ error: "Invalid form cursor." }, 400);
  }
  const view = query.view ?? "active";
  const deletedFilter =
    view === "deleted"
      ? "form.deleted_at IS NOT NULL"
      : "form.deleted_at IS NULL";
  const result = await context.env.DB.prepare(
    `SELECT form.id, form.template_id, form.template_family_id,
            form.template_version, form.template_name, form.definition,
            form.responses, form.status, form.completed_at,
            form.revision, creator.id AS created_by_id,
            creator.name AS created_by_name, creator.email AS created_by_email,
            form.deleted_at, deleted_by.id AS deleted_by_id,
            deleted_by.name AS deleted_by_name,
            deleted_by.email AS deleted_by_email, ${formProjectColumns},
            form.created_at, form.updated_at, COUNT(issue.id) AS issue_count
     FROM forms AS form
     JOIN user AS creator ON creator.id = form.started_by
     JOIN projects AS project ON project.id = form.project_id
     LEFT JOIN user AS deleted_by ON deleted_by.id = form.deleted_by_user_id
     LEFT JOIN issues AS issue ON issue.organization_id = form.organization_id AND issue.target_id = form.id AND issue.target_type = 'form_run'
     WHERE form.organization_id = ? AND ${deletedFilter}
       AND (? IS NULL OR (form.created_at, form.id) < (?, ?))
     GROUP BY form.id
     ORDER BY form.created_at DESC, form.id DESC
     LIMIT ?`,
  )
    .bind(
      context.get("organizationId"),
      cursor?.[0] ?? null,
      cursor?.[0] ?? null,
      cursor?.[1] ?? null,
      formRunPageSize + 1,
    )
    .all<FormSummaryRow>();
  const page = cursorPage(result.results, formRunPageSize, (row) =>
    encodeCursor(row.created_at, row.id),
  );
  return respond(context, formsRoutes.listRuns, {
    forms: page.items.map(toFormSummary),
    nextCursor: page.nextCursor,
  });
});

forms.get("/runs/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const formId = context.req.param("id");
  const [formRows, answerRows] = await context.env.DB.batch<
    FormRow | ActivityRow
  >([
    formStatement(context.env.DB, organizationId, formId),
    formAnswerActivityStatement(context.env.DB, organizationId, formId),
  ]);
  const form = formRows?.results[0] as FormRow | undefined;
  if (!form) return context.json({ error: "Form not found." }, 404);
  const answerActivity = toFormAnswerActivity(
    (answerRows?.results ?? []) as ActivityRow[],
  );
  const [issues, members, images] = await Promise.all([
    findIssues(context.env.DB, organizationId, form.id),
    findMembers(context.env.DB, organizationId),
    findFormIssueImages(context.env.DB, organizationId, form.id),
  ]);
  const imagesByIssue = groupImagesByIssue(images);
  return respond(context, formsRoutes.getRun, {
    form: { ...toForm(form), answerActivity },
    issues: issues.map((row) =>
      toFormIssue(toIssue(row), imagesByIssue.get(row.id) ?? []),
    ),
    members: members.map((member) => ({ ...member })),
  });
});

forms.get("/runs/:id/activity", async (context) => {
  const organizationId = context.get("organizationId");
  const form = await findForm(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!form) return context.json({ error: "Form not found." }, 404);
  const page = await findActivity(
    context.env.DB,
    organizationId,
    context.req.query("cursor"),
    {
      id: form.id,
      type: "form_run",
    },
  );
  return page
    ? respond(context, formsRoutes.runActivity, page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});

forms.patch("/runs/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const form = await findForm(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!form) return context.json({ error: "Form not found." }, 404);
  if (form.deleted_at) return context.json({ error: discardedFormError }, 409);
  const body = await readBody(
    context,
    formsRoutes.saveRun,
    "Invalid form update.",
  );
  if (body instanceof Response) return body;
  if (body.expectedRevision !== form.revision) {
    return context.json(
      { error: "This form has changed. Reload it before saving." },
      409,
    );
  }
  const definition = storedDefinition(form.definition);
  const responses = parseResponses(body.responses, definition);
  if (!responses)
    return context.json({ error: "Invalid form responses." }, 400);
  const status = body.status ?? form.status;
  if (status === "completed" && !allRequiredAnswered(definition, responses)) {
    return context.json({ error: "Complete every required item first." }, 400);
  }
  const now = new Date().toISOString();
  const userId = context.get("authSession").user.id;
  // Answers this save changes take its time and a version of their own, so
  // devices merge against it.
  const saved = answerColumns(
    savedAnswers(storedAnswers(form), responses, {
      at: now,
      by: userId,
      version: crypto.randomUUID(),
    }),
  );
  const update = context.env.DB.prepare(
    `UPDATE forms SET responses = ?, answer_meta = ?, status = ?, completed_at = ?,
                       updated_at = ?, activity_actor_id = ?, revision = revision + 1
     WHERE revision = ? AND id = ? AND organization_id = ?
       AND deleted_at IS NULL`,
  ).bind(
    saved.responses,
    saved.answerMeta,
    status,
    status === "completed" ? (form.completed_at ?? now) : null,
    now,
    userId,
    form.revision,
    form.id,
    organizationId,
  );
  const [updated] = await activityBatch(context.env.DB, context.get("apiKey"), [
    update,
  ]);
  if (Number(updated?.meta.changes) === 0) {
    const exists = await findForm(context.env.DB, organizationId, form.id);
    if (!exists) return context.json({ error: "Form not found." }, 404);
    return context.json(
      {
        error: exists.deleted_at
          ? discardedFormError
          : "This form has changed. Reload it before saving.",
      },
      409,
    );
  }
  return respond(context, formsRoutes.saveRun, { status, updatedAt: now });
});

forms.post("/runs/:id/issues", async (context) => {
  const organizationId = context.get("organizationId");
  const form = await findForm(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!form) return context.json({ error: "Form not found." }, 404);
  if (form.deleted_at) return context.json({ error: discardedFormError }, 409);
  const input = await readBody(
    context,
    formsRoutes.createIssue,
    "Invalid issue details.",
  );
  if (input instanceof Response) return input;
  if (!definitionItemIds(storedDefinition(form.definition)).has(input.itemId))
    return context.json({ error: "Invalid issue details." }, 400);
  const id = crypto.randomUUID();
  const target = {
    type: "form_run" as const,
    id: form.id,
    itemId: input.itemId,
  };
  try {
    const [inserted] = await activityBatch(
      context.env.DB,
      context.get("apiKey"),
      [issueInsert(context, { ...input, id, target })],
    );
    if (!Number(inserted?.meta.changes))
      return context.json({ error: "Issue assignee is not a member." }, 400);
  } catch (cause) {
    const current = await findForm(context.env.DB, organizationId, form.id);
    if (!current) return context.json({ error: "Form not found." }, 404);
    if (current.deleted_at)
      return context.json({ error: discardedFormError }, 409);
    throw cause;
  }
  return respond(context, formsRoutes.createIssue, { issueId: id }, 201);
});

forms.patch("/issues/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const issue = await findIssueForUpdate(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!issue) return context.json({ error: "Issue not found." }, 404);
  if (issue.form_deleted_at)
    return context.json({ error: discardedFormError }, 409);
  const changes = await readBody(
    context,
    formsRoutes.updateIssue,
    "Invalid issue update.",
  );
  if (changes instanceof Response) return changes;
  const now = new Date().toISOString();
  const [result] = await activityBatch(context.env.DB, context.get("apiKey"), [
    issueUpdate(
      context,
      issue.id,
      { ...changes, updatedAt: now },
      {
        bindings: [],
        sql: `target_type = 'form_run' AND NOT EXISTS (
        SELECT 1 FROM forms
        WHERE forms.id = issues.target_id AND forms.deleted_at IS NOT NULL
      )`,
      },
    ),
  ]);
  if (Number(result?.meta.changes) > 0) {
    return respond(context, formsRoutes.updateIssue, {
      assignedTo:
        changes.assignedTo === undefined
          ? issue.assigned_to
          : changes.assignedTo,
      status: changes.status ?? issue.status,
      updatedAt: now,
    });
  }
  const rejected = await rejectedIssueUpdate(
    context.env.DB,
    organizationId,
    issue.id,
    changes.assignedTo,
  );
  return context.json({ error: rejected.error }, rejected.status);
});

/** Why an issue update changed nothing: a non-member assignee, a discard, or a deletion. */
async function rejectedIssueUpdate(
  database: D1Database,
  organizationId: string,
  issueId: string,
  newAssignee: string | null | undefined,
) {
  if (newAssignee && !(await isMember(database, organizationId, newAssignee))) {
    return { error: "Issue assignee is not a member.", status: 400 as const };
  }
  const current = await findIssueForUpdate(database, organizationId, issueId);
  return current?.form_deleted_at
    ? { error: discardedFormError, status: 409 as const }
    : { error: "Issue not found.", status: 404 as const };
}

forms.route("/runs", formRunDiscard);
forms.route("/issues", formIssueImages);
forms.route("/issues", formIssueImageRemoval);

/**
 * Matches while global template ? is still published at current version ?, and
 * when version ? is given, that version of it is published.
 */
const publishedSourceSql = `
  SELECT 1 FROM form_template_families AS source
  JOIN form_template_versions AS sourceVersion
    ON sourceVersion.template_id = source.id
   AND sourceVersion.version = source.current_version
  WHERE source.id = ? AND source.scope = 'global'
    AND sourceVersion.version = ? AND sourceVersion.status = 'published'
    AND (? IS NULL OR EXISTS (
      SELECT 1 FROM form_template_versions AS copied
      WHERE copied.template_id = source.id AND copied.version = ?
        AND copied.status = 'published'
    ))`;

/**
 * Copies a published global template into the organization as a new draft that
 * records its source: the template, and the published version the definition came
 * from when the caller names one. Returns "stale" when the template is no longer
 * published at the current version read, and null when the plan limit is
 * reached; both checks run in the inserting statement.
 */
async function copyGlobalTemplate(
  database: D1Database,
  organizationId: string,
  actor: ActivityActor,
  input: TemplateSaveInput,
  source: { current: TemplateRow; version: number | null },
  templateLimit: number | null,
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const { current } = source;
  const results = await activityBatch(database, actor.apiKey, [
    database
      .prepare(
        `INSERT INTO form_template_families
         (id, scope, organization_id, current_version, created_by, created_at,
          updated_at)
         SELECT ?, 'organization', ?, 1, ?, ?, ?
         WHERE (? IS NULL OR (
           SELECT COUNT(*) FROM form_template_families
           WHERE scope = 'organization' AND organization_id = ?
         ) < ?)
           AND EXISTS (${publishedSourceSql})`,
      )
      .bind(
        id,
        organizationId,
        actor.userId,
        now,
        now,
        templateLimit,
        organizationId,
        templateLimit,
        current.id,
        current.current_version,
        source.version,
        source.version,
      ),
    database
      .prepare(
        `INSERT INTO form_template_versions
         (id, template_id, version, name, description, definition, status,
          created_by, created_at, copied_from_template_id, copied_from_version)
         SELECT ?, ?, 1, ?, ?, ?, 'draft', ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM form_template_families WHERE id = ?
         )`,
      )
      .bind(
        crypto.randomUUID(),
        id,
        input.name,
        input.description,
        JSON.stringify(input.definition),
        actor.userId,
        now,
        current.id,
        source.version,
        id,
      ),
  ]);
  if (!Number(results[0]?.meta.changes)) {
    const latest = await findTemplate(database, organizationId, current.id);
    return latest?.current_version === current.current_version ? null : "stale";
  }
  const saved = await findTemplate(database, organizationId, id);
  if (!saved) throw new Error("Copied template could not be loaded.");
  return saved;
}

async function findIssues(
  database: D1Database,
  organizationId: string,
  formId: string,
) {
  const result = await database
    .prepare(
      `${issueSelect}
       WHERE issue.target_type = 'form_run' AND issue.target_id = ? AND issue.organization_id = ?
       ORDER BY issue.created_at DESC`,
    )
    .bind(formId, organizationId)
    .all<IssueRow>();
  return result.results;
}

async function findMembers(database: D1Database, organizationId: string) {
  const result = await database
    .prepare(
      `SELECT user.id, user.name, user.email
       FROM member JOIN user ON user.id = member.userId
       WHERE member.organizationId = ? ORDER BY user.name ASC`,
    )
    .bind(organizationId)
    .all<MemberRow>();
  return result.results;
}

async function isMember(
  database: D1Database,
  organizationId: string,
  userId: string,
) {
  return Boolean(
    await database
      .prepare(`SELECT id FROM member WHERE organizationId = ? AND userId = ?`)
      .bind(organizationId, userId)
      .first(),
  );
}

function definitionItemIds(definition: FormDefinition) {
  return new Set(
    definition.sections.flatMap((section) =>
      section.items.map((item) => item.id),
    ),
  );
}

function groupImagesByIssue(images: FormIssueImageRow[]) {
  const grouped = new Map<string, FormIssueImageRow[]>();
  for (const image of images) {
    const issueImages = grouped.get(image.issue_id) ?? [];
    issueImages.push(image);
    grouped.set(image.issue_id, issueImages);
  }
  return grouped;
}

/** A form lists its issues with the assignee flattened and their images. */
function toFormIssue(issue: Issue, images: FormIssueImageRow[]): FormIssue {
  return {
    assignedTo: issue.assignedTo?.id ?? null,
    assigneeEmail: issue.assignedTo?.email ?? null,
    assigneeName: issue.assignedTo?.name ?? null,
    createdAt: issue.createdAt,
    createdBy: issue.createdBy,
    description: issue.description,
    id: issue.id,
    images: images.map(toFormIssueImage),
    itemId: issue.target.itemId ?? "",
    priority: issue.priority,
    status: issue.status,
    title: issue.title,
    updatedAt: issue.updatedAt,
  };
}

export { forms };
