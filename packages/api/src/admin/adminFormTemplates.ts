import { adminFormTemplatesRoutes } from "@balebase/validators/adminFormTemplates";
import { Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
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
} from "../forms/formTemplates";
import { findActivity, requestActor } from "../shared/activity";
import { readBody, readQuery, respond } from "../shared/respond";

/**
 * Global form templates, shared by every organization. Platform admins
 * manage them here, outside any organization; organizations can only read
 * and copy them.
 */
const adminFormTemplates = new Hono<ApiEnv>();

adminFormTemplates.get("/", async (context) => {
  const query = readQuery(
    context,
    adminFormTemplatesRoutes.list,
    "Invalid template view.",
  );
  if (query instanceof Response) return query;
  // Form counts cover every organization's forms. A discarded template's
  // current version is its discard, so the newest discards come first.
  const view =
    query.view === "discarded"
      ? "version.status = 'discarded' ORDER BY version.created_at DESC, family.id"
      : "version.status != 'discarded' ORDER BY family.updated_at DESC";
  const result = await context.env.DB.prepare(
    `${templateSummarySelect()}
     WHERE family.scope = 'global' AND ${view}`,
  ).all<TemplateRow & { form_count: number }>();
  return respond(context, adminFormTemplatesRoutes.list, {
    templates: result.results.map(toTemplateSummary),
  });
});

adminFormTemplates.post("/", async (context) => {
  const body = await readBody(
    context,
    adminFormTemplatesRoutes.create,
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
    adminFormTemplatesRoutes.create,
    { template: toTemplate(template) },
    201,
  );
});

// A discarded template's versions and history stay readable here until the purge
// deletes them, so root admins can decide whether to restore it. Its template and
// editor (`GET /:id`) are not: a discarded template must be restored to be edited.
adminFormTemplates.get("/:id/versions", async (context) => {
  const template = await findRetainedGlobalTemplate(
    context.env.DB,
    context.req.param("id"),
  );
  if (!template) return context.json({ error: "Template not found." }, 404);
  return respond(context, adminFormTemplatesRoutes.versions, {
    versions: await listTemplateVersions(context.env.DB, template.id),
  });
});

adminFormTemplates.get("/:id/versions/:version", async (context) => {
  const version = positiveInteger(context.req.param("version"));
  if (!version)
    return context.json({ error: "Template version is invalid." }, 400);
  const template = await findRetainedGlobalTemplate(
    context.env.DB,
    context.req.param("id"),
    version,
  );
  return template
    ? respond(context, adminFormTemplatesRoutes.version, {
        template: toTemplate(template),
      })
    : context.json({ error: "Template version not found." }, 404);
});

adminFormTemplates.get("/:id/activity", async (context) => {
  const template = await findRetainedGlobalTemplate(
    context.env.DB,
    context.req.param("id"),
  );
  if (!template) return context.json({ error: "Template not found." }, 404);
  const page = await findActivity(
    context.env.DB,
    null,
    context.req.query("cursor"),
    { id: template.id, type: "form_template" },
  );
  return page
    ? respond(context, adminFormTemplatesRoutes.activity, page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});

adminFormTemplates.get("/:id", async (context) => {
  const template = await findTemplate(
    context.env.DB,
    null,
    context.req.param("id"),
  );
  return template
    ? respond(context, adminFormTemplatesRoutes.get, {
        template: toTemplate(template),
      })
    : context.json({ error: "Template not found." }, 404);
});

adminFormTemplates.put("/:id", async (context) => {
  const current = await findTemplate(
    context.env.DB,
    null,
    context.req.param("id"),
  );
  if (!current) return context.json({ error: "Template not found." }, 404);
  const body = await readBody(
    context,
    adminFormTemplatesRoutes.update,
    "The template definition is invalid.",
  );
  if (body instanceof Response) return body;
  const { status, ...input } = body;
  if (status === "unpublished" && current.status !== "published") {
    return context.json(
      { error: "Only published templates can be unpublished." },
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
    : respond(context, adminFormTemplatesRoutes.update, {
        template: toTemplate(saved),
      });
});

adminFormTemplates.delete("/:id", async (context) => {
  const current = await findTemplate(
    context.env.DB,
    null,
    context.req.param("id"),
  );
  if (!current) return context.json({ error: "Template not found." }, 404);
  // Organizations stop seeing a template once it is unpublished, so only
  // published templates must be unpublished before they can be discarded.
  if (current.status === "published") {
    return context.json(
      {
        error:
          "Only draft or unpublished templates can be discarded. Unpublish this template first.",
      },
      409,
    );
  }
  const body = await readBody(
    context,
    adminFormTemplatesRoutes.discard,
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
    : respond(context, adminFormTemplatesRoutes.discard, { discarded: true });
});

adminFormTemplates.post("/:id/restore", async (context) => {
  const id = context.req.param("id");
  const discarded = await findDiscardedTemplate(context.env.DB, id);
  if (!discarded) {
    return (await findTemplate(context.env.DB, null, id))
      ? context.json(
          { error: "Only discarded templates can be restored." },
          409,
        )
      : context.json({ error: "Template not found." }, 404);
  }
  const body = await readBody(
    context,
    adminFormTemplatesRoutes.restore,
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
    // The purge job deleted the template between the read and the save.
    if (
      !(await findDiscardedTemplate(context.env.DB, id)) &&
      !(await findTemplate(context.env.DB, null, id))
    )
      return context.json({ error: "Template not found." }, 404);
    throw cause;
  }
  return saved === "stale"
    ? context.json({ error: staleTemplateError }, 409)
    : respond(context, adminFormTemplatesRoutes.restore, {
        template: toTemplate(saved),
      });
});

export { adminFormTemplates };
