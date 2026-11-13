import type { ContractAuthoringInput } from "@balebase/validators/contractAuthoring";
import { ContractMarkdownError } from "@balebase/validators/contractMarkdown";
import {
  type ContractDetail,
  type ContractDraft,
  contractsRoutes,
} from "@balebase/validators/contracts";
import type { Context, Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { activityBatch, requestActor } from "../shared/activity";
import { normalizeFilename } from "../shared/filenames";
import { readBody, respond } from "../shared/respond";
import { trackedPut, uploadStillQueued } from "../shared/storage";
import { draftStatements } from "./contractDraft";
import {
  type RenderedContractMarkdown,
  renderContractMarkdown,
} from "./contractMarkdownPdf";
import { sha256Hex } from "./contractPdf";
import {
  contractCreatedActivity,
  contractExists,
  eventStatement,
  findContract,
} from "./contractRecords";

type AuthoringContext = Context<ApiEnv>;
type ReadDetail = (
  context: AuthoringContext,
  id: string,
) => Promise<ContractDetail | null>;
type Rendered = RenderedContractMarkdown & {
  draft: ContractDraft;
  sha256: string;
};

/** Adds the source-authoring routes without coupling their storage to PDF upload. */
export function registerAuthoredContracts(
  router: Hono<ApiEnv>,
  detailFor: ReadDetail,
) {
  router.post("/authored", (context) => createAuthored(context, detailFor));
  router.put("/:id/authored", (context) => saveAuthored(context, detailFor));
}

async function createAuthored(
  context: AuthoringContext,
  detailFor: ReadDetail,
) {
  const input = await readBody(
    context,
    contractsRoutes.createAuthored,
    "The authored contract is invalid.",
  );
  if (input instanceof Response) return input;
  const rendered = await compile(context, input);
  if (rendered instanceof Response) return rendered;
  const id = crypto.randomUUID();
  const key = await storeDocument(context, id, rendered.bytes);
  const organizationId = context.get("organizationId");
  const actor = requestActor(context);
  const now = new Date().toISOString();
  const database = context.env.DB;
  const result = await activityBatch(database, actor.apiKey, [
    database
      .prepare(`INSERT INTO contracts
        (id, organization_id, title, authoring_json, document_object_key,
         document_filename, document_size, document_sha256, document_page_count,
         created_by, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${uploadStillQueued}`)
      .bind(
        id,
        organizationId,
        input.title,
        JSON.stringify(input),
        key,
        filename(input.title),
        rendered.bytes.byteLength,
        rendered.sha256,
        rendered.pageCount,
        actor.userId,
        now,
        now,
        key,
      ),
    ...draftStatements(
      database,
      { id, organization_id: organizationId },
      rendered.draft,
      now,
      key,
    ),
    eventStatement(
      database,
      {
        actorUserId: actor.userId,
        apiKey: actor.apiKey,
        contractId: id,
        type: "created",
      },
      contractExists(id),
    ),
    contractCreatedActivity(database, actor.userId, id, organizationId),
  ]);
  if (!result[0]?.meta.changes) return changed(context);
  return respond(
    context,
    contractsRoutes.createAuthored,
    { contract: await detailFor(context, id) },
    201,
  );
}

async function saveAuthored(
  context: Context<ApiEnv, "/:id/authored">,
  detailFor: ReadDetail,
) {
  const body = await readBody(
    context,
    contractsRoutes.saveAuthored,
    "The authored contract is invalid.",
  );
  if (body instanceof Response) return body;
  const { expectedRevision, ...input } = body;
  const contract = await findContract(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
  );
  if (!contract) return context.json({ error: "Contract not found." }, 404);
  if (!contract.authoring_json)
    return context.json({ error: "This contract was uploaded as a PDF." }, 409);
  if (contract.status !== "draft" || contract.revision !== expectedRevision)
    return changed(context);
  const rendered = await compile(context, input);
  if (rendered instanceof Response) return rendered;
  const key = await storeDocument(context, contract.id, rendered.bytes);
  const actor = requestActor(context);
  const database = context.env.DB;
  const result = await activityBatch(database, actor.apiKey, [
    database
      .prepare(`UPDATE contracts SET authoring_json = ?, document_object_key = ?,
        document_filename = ?, document_size = ?, document_sha256 = ?, document_page_count = ?
        WHERE id = ? AND organization_id = ? AND status = 'draft' AND revision = ?
          AND ${uploadStillQueued}`)
      .bind(
        JSON.stringify(input),
        key,
        filename(input.title),
        rendered.bytes.byteLength,
        rendered.sha256,
        rendered.pageCount,
        contract.id,
        contract.organization_id,
        expectedRevision,
        key,
      ),
    ...draftStatements(
      database,
      contract,
      rendered.draft,
      new Date().toISOString(),
      key,
    ),
    eventStatement(
      database,
      {
        actorUserId: actor.userId,
        apiKey: actor.apiKey,
        contractId: contract.id,
        type: "source_saved",
        detail: JSON.stringify({
          revision: expectedRevision + 1,
          documentSha256: rendered.sha256,
        }),
      },
      {
        sql: "EXISTS (SELECT 1 FROM contracts WHERE id = ? AND status = 'draft' AND document_object_key = ?)",
        bindings: [contract.id, key],
      },
    ),
  ]);
  if (!result[0]?.meta.changes) return changed(context);
  return respond(context, contractsRoutes.saveAuthored, {
    contract: await detailFor(context, contract.id),
  });
}

async function compile(
  context: AuthoringContext,
  input: ContractAuthoringInput,
): Promise<Rendered | Response> {
  try {
    const rendered = await renderContractMarkdown(input);
    const draft = contractsRoutes.saveDraft.body.safeParse({
      ...input,
      fields: rendered.fields,
    });
    if (!draft.success)
      return context.json(
        {
          error:
            draft.error.issues[0]?.message ??
            "The generated fields are invalid.",
        },
        400,
      );
    if (rendered.bytes.byteLength > 10 * 1024 * 1024)
      return context.json(
        { error: "Contracts must be 10 MB or smaller." },
        400,
      );
    return {
      ...rendered,
      draft: draft.data,
      sha256: await sha256Hex(rendered.bytes),
    };
  } catch (cause) {
    if (cause instanceof ContractMarkdownError)
      return context.json({ error: cause.message }, 400);
    throw cause;
  }
}

async function storeDocument(
  context: AuthoringContext,
  id: string,
  bytes: Uint8Array,
) {
  const organizationId = context.get("organizationId");
  const key = `organizations/${organizationId}/contracts/${id}/source-${crypto.randomUUID()}.pdf`;
  await trackedPut(
    context.env,
    {
      cleanupId: `contract-source:${crypto.randomUUID()}`,
      key,
      organizationId,
    },
    bytes,
    {
      customMetadata: { contractId: id, organizationId },
      httpMetadata: { contentType: "application/pdf" },
    },
  );
  return key;
}

function filename(title: string) {
  return normalizeFilename(`${title}.pdf`, "contract.pdf");
}

function changed(context: AuthoringContext) {
  return context.json(
    {
      error:
        "The contract changed or was sent. Reload it before saving or sending again.",
    },
    409,
  );
}
