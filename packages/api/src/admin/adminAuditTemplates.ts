import { adminAuditTemplatesRoutes } from "@balebase/validators/adminAuditTemplates";
import { Hono } from "hono";
import {
  createTemplate,
  findDiscardedTemplate,
  findRetainedGlobalTemplate,
  findTemplate,
  listTemplateVersions,
  positiveInteger,
  saveTemplateVersion,
  staleTemplateError,
  storedDefinition,
  type TemplateRow,
  templateSummarySelect,
  toTemplate,
  toTemplateSummary,
} from "../audits/auditTemplates";
import type { ApiEnv } from "../auth/apiEnv";
import { findActivity, requestActor } from "../shared/activity";
import { readBody, readQuery, respond } from "../shared/respond";

/**
 * Global audit templates, shared by every organization. Platform admins
 * manage them here, outside any organization; organizations can only read
 * and copy them.
 */
const adminAuditTemplates = new Hono<ApiEnv>();

adminAuditTemplates.get("/", async (context) => {
  const query = readQuery(
    context,
    adminAuditTemplatesRoutes.list,
    "Invalid template view.",
  );
  if (query instanceof Response) return query;
  // Audit counts cover every organization's audits. A discarded form's
  // current version is its discard, so the newest discards come first.
  const view =
    query.view === "discarded"
      ? "version.status = 'discarded' ORDER BY version.created_at DESC, family.id"
      : "version.status != 'discarded' ORDER BY family.updated_at DESC";
  const result = await context.env.DB.prepare(
    `${templateSummarySelect()}
     WHERE family.scope = 'global' AND ${view}`,
  ).all<TemplateRow & { audit_count: number }>();
  return respond(context, adminAuditTemplatesRoutes.list, {
    templates: result.results.map(toTemplateSummary),
  });
});

adminAuditTemplates.post("/", async (context) => {
  const body = await readBody(
    context,
    adminAuditTemplatesRoutes.create,
    "A template name is required.",
  );
  if (body instanceof Response) return body;
  const template = await createTemplate(context.env.DB, {
    actor: requestActor(context),
    name: body.name,
    organizationId: null,
    templateLimit: null,
  });
  if (!template) throw new Error("Global template could not be created.");
  return respond(
    context,
    adminAuditTemplatesRoutes.create,
    { template: toTemplate(template) },
    201,
  );
});

// A discarded form's versions and history stay readable here until the purge
// deletes them, so root admins can decide whether to restore it. Its form and
// editor (`GET /:id`) are not: a discarded form must be restored to be edited.
adminAuditTemplates.get("/:id/versions", async (context) => {
  const template = await findRetainedGlobalTemplate(
    context.env.DB,
    context.req.param("id"),
  );
  if (!template) return context.json({ error: "Template not found." }, 404);
  return respond(context, adminAuditTemplatesRoutes.versions, {
    versions: await listTemplateVersions(context.env.DB, template.id),
  });
});

adminAuditTemplates.get("/:id/versions/:version", async (context) => {
  const version = positiveInteger(context.req.param("version"));
  if (!version)
    return context.json({ error: "Template version is invalid." }, 400);
  const template = await findRetainedGlobalTemplate(
    context.env.DB,
    context.req.param("id"),
    version,
  );
  return template
    ? respond(context, adminAuditTemplatesRoutes.version, {
        template: toTemplate(template),
      })
    : context.json({ error: "Template version not found." }, 404);
});

adminAuditTemplates.get("/:id/activity", async (context) => {
  const template = await findRetainedGlobalTemplate(
    context.env.DB,
    context.req.param("id"),
  );
  if (!template) return context.json({ error: "Template not found." }, 404);
  const page = await findActivity(
    context.env.DB,
    null,
    context.req.query("cursor"),
    { id: template.id, type: "audit_template" },
  );
  return page
    ? respond(context, adminAuditTemplatesRoutes.activity, page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});

adminAuditTemplates.get("/:id", async (context) => {
  const template = await findTemplate(
    context.env.DB,
    null,
    context.req.param("id"),
  );
  return template
    ? respond(context, adminAuditTemplatesRoutes.get, {
        template: toTemplate(template),
      })
    : context.json({ error: "Template not found." }, 404);
});

adminAuditTemplates.put("/:id", async (context) => {
  const current = await findTemplate(
    context.env.DB,
    null,
    context.req.param("id"),
  );
  if (!current) return context.json({ error: "Template not found." }, 404);
  const body = await readBody(
    context,
    adminAuditTemplatesRoutes.update,
    "The template definition is invalid.",
  );
  if (body instanceof Response) return body;
  const { status, ...input } = body;
  if (status === "unpublished" && current.status !== "published") {
    return context.json(
      { error: "Only published forms can be unpublished." },
      409,
    );
  }
  const saved = await saveTemplateVersion(
    context.env.DB,
    null,
    current,
    requestActor(context),
    input,
    status,
  );
  return saved === "stale"
    ? context.json({ error: staleTemplateError }, 409)
    : respond(context, adminAuditTemplatesRoutes.update, {
        template: toTemplate(saved),
      });
});

adminAuditTemplates.delete("/:id", async (context) => {
  const current = await findTemplate(
    context.env.DB,
    null,
    context.req.param("id"),
  );
  if (!current) return context.json({ error: "Template not found." }, 404);
  // Organizations stop seeing a form once it is unpublished, so only
  // published forms must be unpublished before they can be discarded.
  if (current.status === "published") {
    return context.json(
      {
        error:
          "Only draft or unpublished forms can be discarded. Unpublish this form first.",
      },
      409,
    );
  }
  const body = await readBody(
    context,
    adminAuditTemplatesRoutes.discard,
    "The current template version is required.",
  );
  if (body instanceof Response) return body;
  const saved = await saveTemplateVersion(
    context.env.DB,
    null,
    current,
    requestActor(context),
    {
      definition: storedDefinition(current.definition),
      description: current.description,
      expectedCurrentVersion: body.expectedCurrentVersion,
      name: current.name,
    },
    "discarded",
  );
  return saved === "stale"
    ? context.json({ error: staleTemplateError }, 409)
    : respond(context, adminAuditTemplatesRoutes.discard, { discarded: true });
});

adminAuditTemplates.post("/:id/restore", async (context) => {
  const id = context.req.param("id");
  const discarded = await findDiscardedTemplate(context.env.DB, id);
  if (!discarded) {
    return (await findTemplate(context.env.DB, null, id))
      ? context.json({ error: "Only discarded forms can be restored." }, 409)
      : context.json({ error: "Template not found." }, 404);
  }
  const body = await readBody(
    context,
    adminAuditTemplatesRoutes.restore,
    "The current template version is required.",
  );
  if (body instanceof Response) return body;
  const { current, restoredStatus } = discarded;
  let saved: Awaited<ReturnType<typeof saveTemplateVersion>>;
  try {
    saved = await saveTemplateVersion(
      context.env.DB,
      null,
      current,
      requestActor(context),
      {
        definition: storedDefinition(current.definition),
        description: current.description,
        expectedCurrentVersion: body.expectedCurrentVersion,
        name: current.name,
      },
      restoredStatus,
    );
  } catch (cause) {
    // The purge job deleted the form between the read and the save.
    if (
      !(await findDiscardedTemplate(context.env.DB, id)) &&
      !(await findTemplate(context.env.DB, null, id))
    )
      return context.json({ error: "Template not found." }, 404);
    throw cause;
  }
  return saved === "stale"
    ? context.json({ error: staleTemplateError }, 409)
    : respond(context, adminAuditTemplatesRoutes.restore, {
        template: toTemplate(saved),
      });
});

export { adminAuditTemplates };
