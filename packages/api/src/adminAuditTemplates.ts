import { adminAuditTemplatesRoutes } from "@balebase/validators/adminAuditTemplates";
import { Hono } from "hono";
import { findActivity, requestActor } from "./activity";
import { isRecord, validText } from "./auditDefinition";
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
  templateSaveInput,
  templateSelect,
  toTemplate,
} from "./auditTemplates";
import type { AuthVariables } from "./authMiddleware";
import { respond } from "./respond";
import type { Bindings } from "./types";

/**
 * Global audit templates, shared by every organization. Platform admins
 * manage them here, outside any organization; organizations can only read
 * and copy them.
 */
const adminAuditTemplates = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

adminAuditTemplates.get("/", async (context) => {
  await ensureStarterTemplates(context.env.DB);
  const result = await context.env.DB.prepare(
    `${templateSelect}
     WHERE family.scope = 'global' AND version.status != 'discarded'
     ORDER BY family.updated_at DESC`,
  ).all<TemplateRow>();
  return respond(context, adminAuditTemplatesRoutes.list, {
    templates: result.results.map(toTemplate),
  });
});

adminAuditTemplates.post("/", async (context) => {
  const body: unknown = await context.req.json().catch(() => null);
  if (!isRecord(body) || !validText(body.name, 200)) {
    return context.json({ error: "A template name is required." }, 400);
  }
  const template = await createTemplate(context.env.DB, {
    actor: requestActor(context),
    name: body.name.trim(),
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

adminAuditTemplates.get("/:id/versions", async (context) => {
  const template = await findTemplate(
    context.env.DB,
    null,
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
  const template = await findTemplate(
    context.env.DB,
    null,
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
  const template = await findTemplate(
    context.env.DB,
    null,
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
  const body: unknown = await context.req.json().catch(() => null);
  const input = templateSaveInput(body);
  if (typeof input === "string") return context.json({ error: input }, 400);
  const status = isRecord(body) ? body.status : undefined;
  if (
    status !== undefined &&
    status !== "published" &&
    status !== "unpublished"
  ) {
    return context.json({ error: "Template status is invalid." }, 400);
  }
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
  if (current.status !== "draft") {
    return context.json(
      {
        error:
          "Only draft forms can be discarded. Unpublish published forms instead.",
      },
      409,
    );
  }
  const body: unknown = await context.req.json().catch(() => null);
  if (!isRecord(body) || !Number.isSafeInteger(body.expectedCurrentVersion)) {
    return context.json(
      { error: "The current template version is required." },
      400,
    );
  }
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

export { adminAuditTemplates };
