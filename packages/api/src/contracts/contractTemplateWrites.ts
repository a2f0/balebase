import type { ContractAuthoringInput } from "@balebase/validators/contractAuthoring";
import type {
  ContractTemplate,
  contractTemplatesRoutes,
  TemplateDefinition,
} from "@balebase/validators/contractTemplates";
import type { Context } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { stillManages } from "../organizations/organizationMembers";
import {
  activityBatch,
  requestActor,
  rowActivityStatement,
} from "../shared/activity";
import { uploadStillQueued } from "../shared/storage";
import type { templatePublication } from "./contractTemplateDefinition";

type VersionInput = ReturnType<
  typeof contractTemplatesRoutes.saveVersion.body.parse
>;
type Publication = NonNullable<ReturnType<typeof templatePublication>>;
interface TemplateVersionWrite {
  templateId: string;
  versionId: string;
  now: string;
  input: VersionInput;
  publication: Publication;
  definition: TemplateDefinition;
  document: ContractTemplate["document"] & { key: string };
  uploadedKey: string | undefined;
}

export function writeTemplateVersion(
  context: Context<ApiEnv>,
  write: TemplateVersionWrite,
) {
  const database = context.env.DB;
  const actor = requestActor(context);
  const organizationId = context.get("organizationId");
  const { input, templateId, versionId, now, publication } = write;
  const expected = input.expectedCurrentVersion;
  return activityBatch(database, actor.apiKey, [
    insertTemplateVersion(context, write),
    database
      .prepare(`UPDATE contract_templates SET current_version = ?, updated_at = ?
      WHERE id = ? AND organization_id = ? AND current_version = ?
        AND EXISTS (SELECT 1 FROM contract_template_versions WHERE id = ?)`)
      .bind(expected + 1, now, templateId, organizationId, expected, versionId),
    templateActivityStatement(
      database,
      {
        action: publication.action,
        actorId: actor.userId,
        details: `json_object('name', version.name, 'version', version.version,
        'sourceVersion', ?, 'previousName', (SELECT previous.name
          FROM contract_template_versions AS previous
          WHERE previous.template_id = contract_templates.id AND previous.version = ?),
        'documentSha256', version.document_sha256,
        'roleCount', json_array_length(version.definition_json, '$.roles'),
        'fieldCount', json_array_length(version.definition_json, '$.fields'),
        'signingOrder', json_extract(version.definition_json, '$.signingOrder'))`,
        detailBindings: [input.sourceVersion, expected],
        id: templateId,
        occurredAt: now,
        organizationId,
        version: expected + 1,
      },
      { bindings: [versionId], sql: "version.id = ?" },
    ),
  ]);
}

function insertTemplateVersion(
  context: Context<ApiEnv>,
  write: TemplateVersionWrite,
) {
  const {
    input,
    templateId,
    versionId,
    now,
    publication,
    definition,
    document,
    uploadedKey,
  } = write;
  const organizationId = context.get("organizationId");
  const userId = context.get("authSession").user.id;
  const manager = stillManages(organizationId, userId);
  return context.env.DB.prepare(`INSERT INTO contract_template_versions
    (id, template_id, version, name, description, definition_json, authoring_json,
     status, source_version, document_object_key, document_filename, document_size,
     document_sha256, document_page_count, created_by, created_at)
    SELECT ?, family.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM contract_templates AS family
    JOIN contract_template_versions AS source
      ON source.template_id = family.id AND source.version = ?
    JOIN contract_template_versions AS current
      ON current.template_id = family.id AND current.version = family.current_version
    WHERE family.id = ? AND family.organization_id = ? AND family.current_version = ?
      AND EXISTS (SELECT 1 FROM member WHERE organizationId = family.organization_id AND userId = ?)
      AND (current.status = ? OR ${manager.sql})
      AND (? IS NULL OR ${uploadStillQueued})`).bind(
    versionId,
    input.expectedCurrentVersion + 1,
    input.name,
    input.description,
    JSON.stringify(definition),
    input.authoring ? JSON.stringify(input.authoring) : null,
    publication.status,
    input.sourceVersion,
    document.key,
    document.filename,
    document.size,
    document.sha256,
    document.pageCount,
    userId,
    now,
    input.sourceVersion,
    templateId,
    organizationId,
    input.expectedCurrentVersion,
    userId,
    publication.status,
    ...manager.bindings,
    uploadedKey ?? null,
    document.key,
  );
}

export function templateContractInsert(
  context: Context<ApiEnv>,
  input: {
    id: string;
    objectKey: string;
    now: string;
    sourceId: string;
    title: string;
    authoring: ContractAuthoringInput | null;
    document: {
      filename: string;
      bytes: Uint8Array;
      sha256: string;
      pageCount: number;
    };
  },
) {
  const organizationId = context.get("organizationId");
  const { id, objectKey, now, sourceId, title, authoring, document } = input;
  return context.env.DB.prepare(`INSERT INTO contracts
    (id, organization_id, title, authoring_json, document_object_key, document_filename,
     document_size, document_sha256, document_page_count, created_by, created_at,
     updated_at, template_version_id, template_name, template_version)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, selected.id, selected.name, selected.version
    FROM contract_templates AS family
    JOIN contract_template_versions AS selected ON selected.template_id = family.id
    JOIN contract_template_versions AS current
      ON current.template_id = family.id AND current.version = family.current_version
    WHERE selected.id = ? AND family.organization_id = ?
      AND selected.status = 'published' AND current.status = 'published'
      AND ${uploadStillQueued}`).bind(
    id,
    organizationId,
    title,
    authoring ? JSON.stringify(authoring) : null,
    objectKey,
    document.filename,
    document.bytes.byteLength,
    document.sha256,
    document.pageCount,
    context.get("authSession").user.id,
    now,
    now,
    sourceId,
    organizationId,
    objectKey,
  );
}
/**
 * Shared activity about a template, read inside the batch from one of its
 * versions, which `details` and `condition` name `version`. Records nothing
 * unless that version exists and matches `condition`. Never the PDF or
 * field values.
 */
export function templateActivityStatement(
  database: D1Database,
  input: {
    action: string;
    actorId: string;
    details: string;
    detailBindings?: (string | number | null)[];
    id: string;
    occurredAt: string;
    organizationId: string;
    version: number;
  },
  condition: { bindings: (string | number | null)[]; sql: string } = {
    bindings: [],
    sql: "1 = 1",
  },
) {
  const version = `FROM contract_template_versions AS version
    WHERE version.template_id = contract_templates.id
      AND version.version = ${Math.trunc(input.version)}`;
  return rowActivityStatement(
    database,
    {
      action: input.action,
      actorId: input.actorId,
      details: {
        bindings: input.detailBindings ?? [],
        sql: `(SELECT ${input.details} ${version})`,
      },
      id: input.id,
      label: `COALESCE((SELECT version.name ${version}), 'Contract template')`,
      occurredAt: input.occurredAt,
      organizationId: input.organizationId,
      rootType: "contract_template",
      table: "contract_templates",
    },
    {
      bindings: condition.bindings,
      sql: `EXISTS (SELECT 1 ${version} AND (${condition.sql}))`,
    },
  );
}
