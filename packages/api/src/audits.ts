import {
  type AuditDefinition,
  type AuditIssue,
  auditsRoutes,
} from "@balebase/validators/audits";
import type { Issue } from "@balebase/validators/issues";
import { Hono } from "hono";
import {
  type ActivityActor,
  type ActivityRow,
  activityBatch,
  auditAnswerActivityStatement,
  findActivity,
  requestActor,
  toAuditAnswerActivity,
} from "./activity";
import { allRequiredAnswered, parseResponses } from "./auditDefinition";
import {
  type AuditIssueImageRow,
  findAuditIssueImages,
  toAuditIssueImage,
} from "./auditIssueImageRecords";
import { auditIssueImageRemoval } from "./auditIssueImageRemoval";
import { auditIssueImages } from "./auditIssueImages";
import { auditRunDiscard } from "./auditRunDiscard";
import {
  type AuditRow,
  type AuditSummaryRow,
  auditStatement,
  discardedAuditError,
  findAudit,
  findIssueForUpdate,
  toAudit,
  toAuditSummary,
} from "./auditRunRecords";
import {
  createTemplate,
  ensureStarterTemplates,
  findTemplate,
  listTemplateVersions,
  positiveInteger,
  saveTemplateVersion,
  staleTemplateError,
  storedDefinition,
  type TemplateRow,
  type TemplateSaveInput,
  templateSelect,
  toTemplate,
} from "./auditTemplates";
import type { ApiEnv } from "./authMiddleware";
import { freeFormTemplateLimit, organizationTemplateLimit } from "./billing";
import { cursorPage, decodeCursor, encodeCursor } from "./cursorPagination";
import {
  type IssueRow,
  issueInsert,
  issueSelect,
  issueUpdate,
  toIssue,
} from "./issueRecords";
import { readBody, respond } from "./respond";

const audits = new Hono<ApiEnv>();

interface MemberRow {
  email: string;
  id: string;
  name: string;
}

const auditRunPageSize = 100;
audits.get("/templates", async (context) => {
  const organizationId = context.get("organizationId");
  await ensureStarterTemplates(context.env.DB);
  const result = await context.env.DB.prepare(
    `${templateSelect}
     WHERE (family.scope = 'global' AND version.status = 'published')
        OR family.organization_id = ?
     ORDER BY family.updated_at DESC`,
  )
    .bind(organizationId)
    .all<TemplateRow>();
  return respond(context, auditsRoutes.listTemplates, {
    templates: result.results.map(toTemplate),
  });
});

audits.post("/templates", async (context) => {
  const body = await readBody(
    context,
    auditsRoutes.createTemplate,
    "A template name is required.",
  );
  if (body instanceof Response) return body;
  const organizationId = context.get("organizationId");
  const templateLimit = await organizationTemplateLimit(
    context.env.DB,
    organizationId,
    context.env.STRIPE_PRO_PRICE_ID,
    context.env.STRIPE_PRO_LEGACY_PRICE_IDS,
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
        error: `The Free plan is limited to ${templateLimit} form templates. Upgrade to Pro for unlimited forms.`,
      },
      409,
    );
  }
  return respond(
    context,
    auditsRoutes.createTemplate,
    { template: toTemplate(template) },
    201,
  );
});

audits.post("/templates/:id/copies", async (context) => {
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
    auditsRoutes.copyTemplate,
    "The template definition is invalid.",
  );
  if (input instanceof Response) return input;
  if (
    input.expectedCurrentVersion !== undefined &&
    input.expectedCurrentVersion !== source.current_version
  ) {
    return context.json({ error: staleTemplateError }, 409);
  }
  const saved = await copyGlobalTemplate(
    context.env.DB,
    context.get("organizationId"),
    requestActor(context),
    input,
    new Date().toISOString(),
    await organizationTemplateLimit(
      context.env.DB,
      context.get("organizationId"),
      context.env.STRIPE_PRO_PRICE_ID,
      context.env.STRIPE_PRO_LEGACY_PRICE_IDS,
    ),
  );
  if (!saved) {
    return context.json(
      {
        code: "UPGRADE_REQUIRED",
        error: `The Free plan is limited to ${freeFormTemplateLimit} form templates. Upgrade to Pro for unlimited forms.`,
      },
      409,
    );
  }
  return respond(
    context,
    auditsRoutes.copyTemplate,
    { template: toTemplate(saved) },
    201,
  );
});

audits.get("/templates/:id/versions", async (context) => {
  const template = await findTemplate(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
  );
  if (!template) return context.json({ error: "Template not found." }, 404);
  return respond(context, auditsRoutes.templateVersions, {
    versions: await listTemplateVersions(
      context.env.DB,
      template.id,
      template.scope === "global",
    ),
  });
});

audits.get("/templates/:id/versions/:version", async (context) => {
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
    ? respond(context, auditsRoutes.templateVersion, {
        template: toTemplate(template),
      })
    : context.json({ error: "Template version not found." }, 404);
});

audits.get("/templates/:id", async (context) => {
  const template = await findTemplate(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
  );
  return template
    ? respond(context, auditsRoutes.getTemplate, {
        template: toTemplate(template),
      })
    : context.json({ error: "Template not found." }, 404);
});

audits.get("/templates/:id/activity", async (context) => {
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
      type: "audit_template",
      publishedTemplateOnly: template.scope === "global",
    },
  );
  return page
    ? respond(context, auditsRoutes.templateActivity, page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});

audits.put("/templates/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const current = await findTemplate(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!current) return context.json({ error: "Template not found." }, 404);
  if (current.scope === "global") {
    return context.json(
      { error: "Global templates are managed from Global Audits." },
      403,
    );
  }
  const input = await readBody(
    context,
    auditsRoutes.updateTemplate,
    "The template definition is invalid.",
  );
  if (input instanceof Response) return input;
  const saved = await saveTemplateVersion(
    context.env.DB,
    organizationId,
    current,
    requestActor(context),
    input,
  );
  return saved === "stale"
    ? context.json({ error: staleTemplateError }, 409)
    : respond(context, auditsRoutes.updateTemplate, {
        template: toTemplate(saved),
      });
});

audits.post("/templates/:id/runs", async (context) => {
  const template = await findTemplate(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
  );
  if (!template) return context.json({ error: "Template not found." }, 404);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const insert = context.env.DB.prepare(
    `INSERT INTO audits
     (id, organization_id, template_id, template_family_id,
      template_version_id, template_version, template_name, definition,
      responses, status, started_by, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, '{}', 'in_progress', ?, ?, ?)`,
  ).bind(
    id,
    context.get("organizationId"),
    template.id,
    template.version_id,
    template.version,
    template.name,
    template.definition,
    context.get("authSession").user.id,
    now,
    now,
  );
  await activityBatch(context.env.DB, context.get("apiKey"), [insert]);
  return respond(context, auditsRoutes.start, { auditId: id }, 201);
});

audits.get("/runs", async (context) => {
  const cursorValue = context.req.query("cursor");
  const cursor =
    cursorValue === undefined
      ? undefined
      : decodeCursor(cursorValue, "createdAt", 2048);
  if (cursorValue !== undefined && !cursor) {
    return context.json({ error: "Invalid audit cursor." }, 400);
  }
  const view = context.req.query("view") ?? "active";
  if (view !== "active" && view !== "deleted") {
    return context.json({ error: "Invalid audit view." }, 400);
  }
  const deletedFilter =
    view === "deleted"
      ? "audit.deleted_at IS NOT NULL"
      : "audit.deleted_at IS NULL";
  const result = await context.env.DB.prepare(
    `SELECT audit.id, audit.template_id, audit.template_family_id,
            audit.template_version, audit.template_name, audit.definition,
            audit.responses, audit.status, audit.completed_at,
            audit.revision, creator.id AS created_by_id,
            creator.name AS created_by_name, creator.email AS created_by_email,
            audit.deleted_at, deleted_by.id AS deleted_by_id,
            deleted_by.name AS deleted_by_name,
            deleted_by.email AS deleted_by_email,
            audit.created_at, audit.updated_at, COUNT(issue.id) AS issue_count
     FROM audits AS audit
     JOIN user AS creator ON creator.id = audit.started_by
     LEFT JOIN user AS deleted_by ON deleted_by.id = audit.deleted_by_user_id
     LEFT JOIN issues AS issue ON issue.organization_id = audit.organization_id AND issue.target_id = audit.id AND issue.target_type = 'audit_run'
     WHERE audit.organization_id = ? AND ${deletedFilter}
       AND (? IS NULL OR (audit.created_at, audit.id) < (?, ?))
     GROUP BY audit.id
     ORDER BY audit.created_at DESC, audit.id DESC
     LIMIT ?`,
  )
    .bind(
      context.get("organizationId"),
      cursor?.[0] ?? null,
      cursor?.[0] ?? null,
      cursor?.[1] ?? null,
      auditRunPageSize + 1,
    )
    .all<AuditSummaryRow>();
  const page = cursorPage(result.results, auditRunPageSize, (row) =>
    encodeCursor(row.created_at, row.id),
  );
  return respond(context, auditsRoutes.listRuns, {
    audits: page.items.map(toAuditSummary),
    nextCursor: page.nextCursor,
  });
});

audits.get("/runs/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const auditId = context.req.param("id");
  const [auditRows, answerRows] = await context.env.DB.batch<
    AuditRow | ActivityRow
  >([
    auditStatement(context.env.DB, organizationId, auditId),
    auditAnswerActivityStatement(context.env.DB, organizationId, auditId),
  ]);
  const audit = auditRows?.results[0] as AuditRow | undefined;
  if (!audit) return context.json({ error: "Audit not found." }, 404);
  const answerActivity = toAuditAnswerActivity(
    (answerRows?.results ?? []) as ActivityRow[],
  );
  const [issues, members, images] = await Promise.all([
    findIssues(context.env.DB, organizationId, audit.id),
    findMembers(context.env.DB, organizationId),
    findAuditIssueImages(context.env.DB, organizationId, audit.id),
  ]);
  const imagesByIssue = groupImagesByIssue(images);
  return respond(context, auditsRoutes.getRun, {
    audit: { ...toAudit(audit), answerActivity },
    issues: issues.map((row) =>
      toAuditIssue(toIssue(row), imagesByIssue.get(row.id) ?? []),
    ),
    members: members.map((member) => ({ ...member })),
  });
});

audits.get("/runs/:id/activity", async (context) => {
  const organizationId = context.get("organizationId");
  const audit = await findAudit(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!audit) return context.json({ error: "Audit not found." }, 404);
  const page = await findActivity(
    context.env.DB,
    organizationId,
    context.req.query("cursor"),
    {
      id: audit.id,
      type: "audit_run",
    },
  );
  return page
    ? respond(context, auditsRoutes.runActivity, page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});

audits.patch("/runs/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const audit = await findAudit(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!audit) return context.json({ error: "Audit not found." }, 404);
  if (audit.deleted_at)
    return context.json({ error: discardedAuditError }, 409);
  const body = await readBody(
    context,
    auditsRoutes.saveRun,
    "Invalid audit update.",
  );
  if (body instanceof Response) return body;
  if (body.expectedRevision !== audit.revision) {
    return context.json(
      { error: "This audit has changed. Reload it before saving." },
      409,
    );
  }
  const definition = storedDefinition(audit.definition);
  const responses = parseResponses(body.responses, definition);
  if (!responses)
    return context.json({ error: "Invalid audit responses." }, 400);
  const status = body.status ?? audit.status;
  if (status === "completed" && !allRequiredAnswered(definition, responses)) {
    return context.json({ error: "Complete every required item first." }, 400);
  }
  const now = new Date().toISOString();
  const update = context.env.DB.prepare(
    `UPDATE audits SET responses = ?, status = ?, completed_at = ?, updated_at = ?,
                       activity_actor_id = ?, revision = revision + 1
     WHERE revision = ? AND id = ? AND organization_id = ?
       AND deleted_at IS NULL`,
  ).bind(
    JSON.stringify(responses),
    status,
    status === "completed" ? (audit.completed_at ?? now) : null,
    now,
    context.get("authSession").user.id,
    audit.revision,
    audit.id,
    organizationId,
  );
  const [updated] = await activityBatch(context.env.DB, context.get("apiKey"), [
    update,
  ]);
  if (Number(updated?.meta.changes) === 0) {
    const exists = await findAudit(context.env.DB, organizationId, audit.id);
    if (!exists) return context.json({ error: "Audit not found." }, 404);
    return context.json(
      {
        error: exists.deleted_at
          ? discardedAuditError
          : "This audit has changed. Reload it before saving.",
      },
      409,
    );
  }
  return respond(context, auditsRoutes.saveRun, { status, updatedAt: now });
});

audits.post("/runs/:id/issues", async (context) => {
  const organizationId = context.get("organizationId");
  const audit = await findAudit(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!audit) return context.json({ error: "Audit not found." }, 404);
  if (audit.deleted_at)
    return context.json({ error: discardedAuditError }, 409);
  const input = await readBody(
    context,
    auditsRoutes.createIssue,
    "Invalid issue details.",
  );
  if (input instanceof Response) return input;
  if (!definitionItemIds(storedDefinition(audit.definition)).has(input.itemId))
    return context.json({ error: "Invalid issue details." }, 400);
  const id = crypto.randomUUID();
  const target = {
    type: "audit_run" as const,
    id: audit.id,
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
    const current = await findAudit(context.env.DB, organizationId, audit.id);
    if (!current) return context.json({ error: "Audit not found." }, 404);
    if (current.deleted_at)
      return context.json({ error: discardedAuditError }, 409);
    throw cause;
  }
  return respond(context, auditsRoutes.createIssue, { issueId: id }, 201);
});

audits.patch("/issues/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const issue = await findIssueForUpdate(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!issue) return context.json({ error: "Issue not found." }, 404);
  if (issue.audit_deleted_at)
    return context.json({ error: discardedAuditError }, 409);
  const changes = await readBody(
    context,
    auditsRoutes.updateIssue,
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
        sql: `target_type = 'audit_run' AND NOT EXISTS (
        SELECT 1 FROM audits
        WHERE audits.id = issues.target_id AND audits.deleted_at IS NOT NULL
      )`,
      },
    ),
  ]);
  if (Number(result?.meta.changes) > 0) {
    return respond(context, auditsRoutes.updateIssue, {
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
  return current?.audit_deleted_at
    ? { error: discardedAuditError, status: 409 as const }
    : { error: "Issue not found.", status: 404 as const };
}

audits.route("/runs", auditRunDiscard);
audits.route("/issues", auditIssueImages);
audits.route("/issues", auditIssueImageRemoval);

async function copyGlobalTemplate(
  database: D1Database,
  organizationId: string,
  actor: ActivityActor,
  input: TemplateSaveInput,
  now: string,
  templateLimit: number | null,
) {
  const id = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const results = await activityBatch(database, actor.apiKey, [
    database
      .prepare(
        `INSERT INTO audit_template_families
         (id, scope, organization_id, current_version, created_by, created_at,
          updated_at)
         SELECT ?, 'organization', ?, 1, ?, ?, ?
         WHERE ? IS NULL OR (
           SELECT COUNT(*) FROM audit_template_families
           WHERE scope = 'organization' AND organization_id = ?
         ) < ?`,
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
      ),
    database
      .prepare(
        `INSERT INTO audit_template_versions
         (id, template_id, version, name, description, definition, status,
          created_by, created_at)
         SELECT ?, ?, 1, ?, ?, ?, 'draft', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM audit_template_families WHERE id = ?
         )`,
      )
      .bind(
        versionId,
        id,
        input.name,
        input.description,
        JSON.stringify(input.definition),
        actor.userId,
        now,
        id,
      ),
  ]);
  if (Number(results[0]?.meta.changes) !== 1) return null;
  const saved = await findTemplate(database, organizationId, id);
  if (!saved) throw new Error("Copied template could not be loaded.");
  return saved;
}

async function findIssues(
  database: D1Database,
  organizationId: string,
  auditId: string,
) {
  const result = await database
    .prepare(
      `${issueSelect}
       WHERE issue.target_type = 'audit_run' AND issue.target_id = ? AND issue.organization_id = ?
       ORDER BY issue.created_at DESC`,
    )
    .bind(auditId, organizationId)
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

function definitionItemIds(definition: AuditDefinition) {
  return new Set(
    definition.sections.flatMap((section) =>
      section.items.map((item) => item.id),
    ),
  );
}

function groupImagesByIssue(images: AuditIssueImageRow[]) {
  const grouped = new Map<string, AuditIssueImageRow[]>();
  for (const image of images) {
    const issueImages = grouped.get(image.issue_id) ?? [];
    issueImages.push(image);
    grouped.set(image.issue_id, issueImages);
  }
  return grouped;
}

/** An audit lists its issues with the assignee flattened and their images. */
function toAuditIssue(issue: Issue, images: AuditIssueImageRow[]): AuditIssue {
  return {
    assignedTo: issue.assignedTo?.id ?? null,
    assigneeEmail: issue.assignedTo?.email ?? null,
    assigneeName: issue.assignedTo?.name ?? null,
    createdAt: issue.createdAt,
    createdBy: issue.createdBy,
    description: issue.description,
    id: issue.id,
    images: images.map(toAuditIssueImage),
    itemId: issue.target.itemId ?? "",
    priority: issue.priority,
    status: issue.status,
    title: issue.title,
    updatedAt: issue.updatedAt,
  };
}

export { audits };
