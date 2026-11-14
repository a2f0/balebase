import { ContractMarkdownError } from "@balebase/validators/contractMarkdown";
import {
  type ContractTemplate,
  type ContractTemplateAuthoring,
  type ContractTemplateSummary,
  contractTemplatesRoutes,
  type TemplateDefinition,
  type TemplateVersion,
} from "@balebase/validators/contractTemplates";
import { type Context, Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { canManage, stillManages } from "../organizations/organizationMembers";
import {
  activityBatch,
  findActivity,
  requestActor,
  rowActivityStatement,
} from "../shared/activity";
import { normalizeFilename } from "../shared/filenames";
import { readBody, readQuery, respond } from "../shared/respond";
import {
  readBoundedForm,
  storedDownload,
  trackedPut,
  uploadExpired,
  uploadStillQueued,
} from "../shared/storage";
import {
  draftStatements,
  fieldsOnDocument,
  offPageError,
} from "./contractDraft";
import { InvalidPdfError, inspectPdf, sha256Hex } from "./contractPdf";
import {
  contractCreatedActivity,
  contractExists,
  eventStatement,
} from "./contractRecords";
import {
  mappedDraft,
  renderTemplateContract,
  templatePreview,
  templatePublication,
} from "./contractTemplateDefinition";
import {
  templateActivityStatement,
  templateContractInsert,
  writeTemplateVersion,
} from "./contractTemplateWrites";

type TemplateContext = Context<ApiEnv>;
interface VersionRow {
  authoring_json: string | null;
  created_at: string;
  created_by_name: string | null;
  current_version: number;
  current_status: ContractTemplate["status"];
  definition_json: string;
  description: string;
  document_filename: string;
  document_object_key: string;
  document_page_count: number;
  document_sha256: string;
  document_size: number;
  id: string;
  name: string;
  status: ContractTemplate["status"];
  template_id: string;
  version: number;
}
interface DocumentInput {
  bytes: Uint8Array;
  filename: string;
  pageCount: number;
  sha256: string;
}

const contractTemplates = new Hono<ApiEnv>();
const maxDocumentBytes = 10 * 1024 * 1024;
const documentTooLarge = "Contract templates must be 10 MB or smaller.";

contractTemplates.get("/", async (context) => {
  const result = await context.env.DB.prepare(
    `SELECT family.id, version.name, version.description, version.status,
            CASE WHEN version.authoring_json IS NULL THEN 'pdf' ELSE 'markdown' END AS format,
            family.current_version AS currentVersion, family.updated_at AS updatedAt
     FROM contract_templates AS family
     JOIN contract_template_versions AS version
       ON version.template_id = family.id AND version.version = family.current_version
     WHERE family.organization_id = ?
     ORDER BY family.updated_at DESC, family.id DESC`,
  )
    .bind(context.get("organizationId"))
    .all<ContractTemplateSummary>();
  return respond(context, contractTemplatesRoutes.list, {
    templates: result.results,
  });
});

contractTemplates.post("/", async (context) => {
  const form = await readBoundedForm(context.req.raw, maxDocumentBytes);
  const document =
    form === "too_large"
      ? documentTooLarge
      : await readDocument(form?.get("file"));
  if (typeof document === "string")
    return context.json({ error: document }, 400);
  const definition: TemplateDefinition = {
    fields: [],
    message: "",
    reminderIntervalDays: null,
    roles: [{ key: crypto.randomUUID(), label: "Signer", routingOrder: 1 }],
    signingOrder: "parallel",
  };
  const template = await createTemplate(
    context,
    {
      authoring: null,
      definition,
      description: "",
      name:
        document.filename.replace(/\.pdf$/i, "").slice(0, 200) ||
        "Contract template",
    },
    document,
  );
  if (template instanceof Response) return template;
  return respond(context, contractTemplatesRoutes.upload, { template }, 201);
});

contractTemplates.post("/authored", async (context) => {
  const input = await readBody(
    context,
    contractTemplatesRoutes.createAuthored,
    "The authored template is invalid.",
  );
  if (input instanceof Response) return input;
  try {
    const preview = await templatePreview(input);
    const template = await createTemplate(
      context,
      { ...input, definition: preview.definition },
      preview.document,
    );
    if (template instanceof Response) return template;
    return respond(
      context,
      contractTemplatesRoutes.createAuthored,
      { template },
      201,
    );
  } catch (cause) {
    if (cause instanceof ContractMarkdownError)
      return context.json({ error: cause.message }, 400);
    throw cause;
  }
});

async function createTemplate(
  context: TemplateContext,
  input: {
    authoring: ContractTemplateAuthoring | null;
    definition: TemplateDefinition;
    description: string;
    name: string;
  },
  document: DocumentInput,
) {
  const organizationId = context.get("organizationId");
  const id = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const objectKey = `organizations/${organizationId}/contract-templates/${id}/${versionId}.pdf`;
  await trackedPut(
    context.env,
    {
      cleanupId: `contract-template-upload:${versionId}`,
      key: objectKey,
      organizationId,
    },
    document.bytes,
    {
      customMetadata: { organizationId },
      httpMetadata: { contentType: "application/pdf" },
    },
  );
  const actor = requestActor(context);
  let created: D1Result[];
  try {
    created = await activityBatch(context.env.DB, actor.apiKey, [
      context.env.DB.prepare(
        `INSERT INTO contract_templates (id, organization_id, current_version, created_at, updated_at)
         SELECT ?, ?, 1, ?, ? WHERE ${uploadStillQueued}`,
      ).bind(id, organizationId, now, now, objectKey),
      context.env.DB.prepare(
        `INSERT INTO contract_template_versions
          (id, template_id, version, name, description, definition_json, authoring_json,
           status, document_object_key, document_filename, document_size, document_sha256,
           document_page_count, created_by, created_at)
         SELECT ?, ?, 1, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM contract_templates WHERE id = ?)`,
      ).bind(
        versionId,
        id,
        input.name,
        input.description,
        JSON.stringify(input.definition),
        input.authoring ? JSON.stringify(input.authoring) : null,
        objectKey,
        document.filename,
        document.bytes.byteLength,
        document.sha256,
        document.pageCount,
        actor.userId,
        now,
        id,
      ),
      templateActivityStatement(context.env.DB, {
        action: "contract_template.created",
        actorId: actor.userId,
        details: `json_object('name', version.name, 'version', version.version,
          'documentSha256', version.document_sha256,
          'pageCount', version.document_page_count)`,
        id,
        occurredAt: now,
        organizationId,
        version: 1,
      }),
    ]);
  } catch (cause) {
    await context.env.STORAGE.delete(objectKey);
    throw cause;
  }
  if (!created[0]?.meta.changes) {
    await context.env.STORAGE.delete(objectKey);
    return context.json({ error: uploadExpired }, 409);
  }
  const template = await findVersion(context, id);
  return template && toDetail(template);
}

contractTemplates.get("/:id", async (context) => {
  const query = readQuery(
    context,
    contractTemplatesRoutes.get,
    "Choose a template version.",
  );
  if (query instanceof Response) return query;
  const version = await findVersion(
    context,
    context.req.param("id"),
    query.version ? Number(query.version) : undefined,
  );
  if (!version) return notFound(context);
  return respond(context, contractTemplatesRoutes.get, {
    template: toDetail(version),
  });
});

contractTemplates.get("/:id/versions", async (context) => {
  if (!(await findVersion(context, context.req.param("id"))))
    return notFound(context);
  const result = await context.env.DB.prepare(
    `SELECT version.version, version.name, version.status, version.created_at AS createdAt,
            creator.name AS createdByName
     FROM contract_template_versions AS version
     JOIN contract_templates AS family ON family.id = version.template_id
     LEFT JOIN user AS creator ON creator.id = version.created_by
     WHERE family.id = ? AND family.organization_id = ? ORDER BY version.version DESC`,
  )
    .bind(context.req.param("id"), context.get("organizationId"))
    .all<TemplateVersion>();
  return respond(context, contractTemplatesRoutes.versions, {
    versions: result.results,
  });
});

// A template's own history, readable by every member while it exists; its
// deletion stays in the organization's activity.
contractTemplates.get("/:id/activity", async (context) => {
  const template = await findVersion(context, context.req.param("id"));
  if (!template) return notFound(context);
  const page = await findActivity(
    context.env.DB,
    context.get("organizationId"),
    context.req.query("cursor"),
    { id: template.template_id, type: "contract_template" },
  );
  return page
    ? respond(context, contractTemplatesRoutes.activity, page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});

contractTemplates.get("/:id/document", async (context) => {
  const query = readQuery(
    context,
    contractTemplatesRoutes.document,
    "Choose a template version.",
  );
  if (query instanceof Response) return query;
  const version = await findVersion(
    context,
    context.req.param("id"),
    query.version ? Number(query.version) : undefined,
  );
  if (!version) return notFound(context);
  const download = await storedDownload(
    context.env.STORAGE,
    version.document_object_key,
    {
      fallbackFilename: "contract.pdf",
      filename: version.document_filename,
      headers: { "content-type": "application/pdf" },
    },
  );
  return (
    download ?? context.json({ error: "The document file is missing." }, 404)
  );
});

// Saving always appends a version, and guards against overwriting a newer save.
contractTemplates.post("/:id/versions", async (context) => {
  const input = await readBody(
    context,
    contractTemplatesRoutes.saveVersion,
    "The template is invalid.",
  );
  if (input instanceof Response) return input;
  const { expectedCurrentVersion: expected, sourceVersion } = input;
  const source = await findVersion(
    context,
    context.req.param("id"),
    sourceVersion,
  );
  if (!source) return notFound(context);
  if (source.current_version !== expected) return changed(context);
  const publication = templatePublication(source.current_status, input.status);
  if (!publication)
    return context.json(
      { error: "Only published templates can be unpublished." },
      409,
    );
  const changesPublication = publication.status !== source.current_status;
  if (changesPublication && !canManage(context))
    return publicationDenied(context);
  if (Boolean(source.authoring_json) !== Boolean(input.authoring))
    return context.json(
      {
        error: source.authoring_json
          ? "Markdown templates require their authoring source."
          : "PDF templates cannot be changed into Markdown templates.",
      },
      400,
    );
  const now = new Date().toISOString();
  const organizationId = context.get("organizationId");
  const manager = stillManages(
    organizationId,
    context.get("authSession").user.id,
  );
  const versionId = crypto.randomUUID();
  const prepared = await prepareVersionDocument(
    context,
    source,
    versionId,
    input,
  );
  if (prepared instanceof Response) return prepared;
  const { uploadedKey } = prepared;
  let saved: D1Result[];
  try {
    saved = await writeTemplateVersion(context, {
      ...prepared,
      templateId: source.template_id,
      versionId,
      now,
      input,
      publication,
    });
  } catch (cause) {
    if (uploadedKey) await context.env.STORAGE.delete(uploadedKey);
    throw cause;
  }
  if (!saved[0]?.meta.changes) {
    if (uploadedKey) await context.env.STORAGE.delete(uploadedKey);
    if (
      changesPublication &&
      !(await context.env.DB.prepare(`SELECT 1 WHERE ${manager.sql}`)
        .bind(...manager.bindings)
        .first())
    )
      return publicationDenied(context);
    return changed(context);
  }
  const created = await findVersion(context, source.template_id, expected + 1);
  return respond(
    context,
    contractTemplatesRoutes.saveVersion,
    {
      template: created && toDetail(created),
    },
    201,
  );
});

contractTemplates.post("/:id/contracts", async (context) => {
  const body = await readBody(
    context,
    contractTemplatesRoutes.createContract,
    "Choose a template version.",
  );
  if (body instanceof Response) return body;
  const source = await findVersion(
    context,
    context.req.param("id"),
    body.version,
  );
  if (!source) return notFound(context);
  if (source.status !== "published" || source.current_status !== "published")
    return notPublished(context);
  const prepared = await prepareTemplateContract(context, source, body);
  if (prepared instanceof Response) return prepared;
  const { draft, authoring, document } = prepared;
  const organizationId = context.get("organizationId");
  const id = crypto.randomUUID();
  const objectKey = `organizations/${organizationId}/contracts/${id}/original.pdf`;
  const now = new Date().toISOString();
  await trackedPut(
    context.env,
    { cleanupId: `contract-upload:${id}`, key: objectKey, organizationId },
    document.bytes,
    {
      customMetadata: { contractId: id, organizationId },
      httpMetadata: { contentType: "application/pdf" },
    },
  );
  const actor = requestActor(context);
  try {
    const result = await activityBatch(context.env.DB, actor.apiKey, [
      templateContractInsert(context, {
        id,
        objectKey,
        now,
        sourceId: source.id,
        title: draft.title,
        authoring,
        document,
      }),
      ...draftStatements(
        context.env.DB,
        { id, organization_id: organizationId },
        draft,
        now,
        objectKey,
      ),
      eventStatement(
        context.env.DB,
        {
          actorUserId: actor.userId,
          apiKey: actor.apiKey,
          contractId: id,
          detail: `${source.name} · v${source.version}`,
          type: "created_from_template",
        },
        contractExists(id),
      ),
      contractCreatedActivity(context.env.DB, actor.userId, id, organizationId),
    ]);
    if (!result[0]?.meta.changes) {
      await context.env.STORAGE.delete(objectKey);
      return (await findVersion(context, source.template_id))
        ? notPublished(context)
        : notFound(context);
    }
  } catch (cause) {
    await context.env.STORAGE.delete(objectKey);
    throw cause;
  }
  return respond(
    context,
    contractTemplatesRoutes.createContract,
    { contractId: id },
    201,
  );
});

// Every version goes with the template; contracts made from it keep their
// name and version snapshot, and the shared activity keeps the deletion.
contractTemplates.delete("/:id", async (context) => {
  const database = context.env.DB;
  const id = context.req.param("id");
  const organizationId = context.get("organizationId");
  const actor = requestActor(context);
  const current = `(SELECT name FROM contract_template_versions
    WHERE template_id = contract_templates.id
      AND version = contract_templates.current_version)`;
  const result = await activityBatch(database, actor.apiKey, [
    rowActivityStatement(database, {
      action: "contract_template.deleted",
      actorId: actor.userId,
      details: {
        bindings: [],
        sql: `json_object('title', ${current},
          'version', current_version,
          'versionCount', (SELECT COUNT(*) FROM contract_template_versions
            WHERE template_id = contract_templates.id))`,
      },
      id,
      label: `COALESCE(${current}, 'Contract template')`,
      occurredAt: new Date().toISOString(),
      organizationId,
      rootType: "contract_template",
      table: "contract_templates",
    }),
    database
      .prepare(
        "DELETE FROM contract_templates WHERE id = ? AND organization_id = ?",
      )
      .bind(id, organizationId),
  ]);
  if (!result.at(-1)?.meta.changes) return notFound(context);
  return context.body(null, 204);
});

function findVersion(context: TemplateContext, id: string, version?: number) {
  return context.env.DB.prepare(
    `SELECT version.*, family.current_version, current.status AS current_status,
            creator.name AS created_by_name
     FROM contract_templates AS family
     JOIN contract_template_versions AS version ON version.template_id = family.id
     JOIN contract_template_versions AS current
       ON current.template_id = family.id AND current.version = family.current_version
     LEFT JOIN user AS creator ON creator.id = version.created_by
     WHERE family.id = ? AND family.organization_id = ?
       AND version.version = COALESCE(?, family.current_version)`,
  )
    .bind(id, context.get("organizationId"), version ?? null)
    .first<VersionRow>();
}

function toDetail(row: VersionRow): ContractTemplate {
  return {
    authoring: row.authoring_json
      ? (JSON.parse(row.authoring_json) as ContractTemplateAuthoring)
      : null,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
    currentVersion: row.current_version,
    currentStatus: row.current_status,
    definition: JSON.parse(row.definition_json) as TemplateDefinition,
    description: row.description,
    document: {
      filename: row.document_filename,
      pageCount: row.document_page_count,
      sha256: row.document_sha256,
      size: row.document_size,
    },
    id: row.template_id,
    name: row.name,
    status: row.status,
    version: row.version,
  };
}

async function readDocument(file: unknown): Promise<DocumentInput | string> {
  if (!(file instanceof File)) return "Choose a PDF to upload.";
  if (file.size > maxDocumentBytes) return documentTooLarge;
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const { pageCount } = await inspectPdf(bytes);
    return {
      bytes,
      filename: normalizeFilename(file.name || "contract.pdf", "contract.pdf"),
      pageCount,
      sha256: await sha256Hex(bytes),
    };
  } catch (cause) {
    if (cause instanceof InvalidPdfError) return cause.message;
    throw cause;
  }
}

function notFound(context: TemplateContext) {
  return context.json({ error: "Contract template not found." }, 404);
}

export { contractTemplates };

function changed(context: TemplateContext) {
  return context.json(
    {
      error:
        "This template changed. Reload the latest version before saving your changes.",
    },
    409,
  );
}

function publicationDenied(context: TemplateContext) {
  return context.json(
    {
      error: "Only organization managers can publish or unpublish templates.",
    },
    403,
  );
}

function notPublished(context: TemplateContext) {
  return context.json(
    {
      error: "Choose a published version of a currently published template.",
    },
    409,
  );
}

type VersionInput = ReturnType<
  typeof contractTemplatesRoutes.saveVersion.body.parse
>;

async function prepareVersionDocument(
  context: TemplateContext,
  source: VersionRow,
  versionId: string,
  input: VersionInput,
) {
  if (!input.authoring) {
    if (!fieldsOnDocument(input.definition.fields, source.document_page_count))
      return context.json({ error: offPageError }, 400);
    return {
      definition: input.definition,
      document: {
        key: source.document_object_key,
        filename: source.document_filename,
        size: source.document_size,
        sha256: source.document_sha256,
        pageCount: source.document_page_count,
      },
      uploadedKey: undefined,
    };
  }
  try {
    const preview = await templatePreview({
      ...input,
      authoring: input.authoring,
    });
    const organizationId = context.get("organizationId");
    const key = `organizations/${organizationId}/contract-templates/${source.template_id}/${versionId}.pdf`;
    await trackedPut(
      context.env,
      {
        cleanupId: `contract-template-upload:${versionId}`,
        key,
        organizationId,
      },
      preview.document.bytes,
      {
        customMetadata: { organizationId },
        httpMetadata: { contentType: "application/pdf" },
      },
    );
    return {
      definition: preview.definition,
      document: {
        key,
        filename: preview.document.filename,
        size: preview.document.bytes.byteLength,
        sha256: preview.document.sha256,
        pageCount: preview.document.pageCount,
      },
      uploadedKey: key,
    };
  } catch (cause) {
    if (cause instanceof ContractMarkdownError)
      return context.json({ error: cause.message }, 400);
    throw cause;
  }
}

async function prepareTemplateContract(
  context: TemplateContext,
  source: VersionRow,
  body: ReturnType<typeof contractTemplatesRoutes.createContract.body.parse>,
) {
  if (!source.authoring_json && body.values && Object.keys(body.values).length)
    return context.json(
      { error: "Merge values are only supported by written templates." },
      400,
    );
  const definition = JSON.parse(source.definition_json) as TemplateDefinition;
  const draft = mappedDraft(
    body,
    source.name,
    definition,
    source.document_page_count,
  );
  if (typeof draft === "string") return context.json({ error: draft }, 400);
  if (source.authoring_json) {
    const authoring = JSON.parse(
      source.authoring_json,
    ) as ContractTemplateAuthoring;
    try {
      return await renderTemplateContract({
        ...authoring,
        title: draft.title,
        message: draft.message,
        dueDate: draft.dueDate,
        recipients: draft.recipients,
        reminderIntervalDays: draft.reminderIntervalDays,
        signingOrder: draft.signingOrder,
        values: { ...authoring.values, ...body.values },
      });
    } catch (cause) {
      if (cause instanceof ContractMarkdownError)
        return context.json({ error: cause.message }, 400);
      throw cause;
    }
  }
  const object = await context.env.STORAGE.get(source.document_object_key);
  if (!object)
    return context.json({ error: "The template document is missing." }, 404);
  return {
    authoring: null,
    draft,
    document: {
      bytes: new Uint8Array(await object.arrayBuffer()),
      filename: source.document_filename,
      pageCount: source.document_page_count,
      sha256: source.document_sha256,
    },
  };
}
