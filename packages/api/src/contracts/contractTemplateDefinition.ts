import {
  type ContractAuthoringInput,
  ContractAuthoringSchema,
} from "@balebase/validators/contractAuthoring";
import {
  ContractMarkdownError,
  parseContractMarkdown,
} from "@balebase/validators/contractMarkdown";
import { contractsRoutes } from "@balebase/validators/contracts";
import type {
  contractTemplatesRoutes,
  TemplateDefinition,
} from "@balebase/validators/contractTemplates";
import type { z } from "zod";
import { normalizeFilename } from "../shared/filenames";
import { fieldsOnDocument, offPageError, validEmail } from "./contractDraft";
import { renderContractMarkdown } from "./contractMarkdownPdf";
import { sha256Hex } from "./contractPdf";

/** One transition table, applied to the latest version, never the edited source. */
export function templatePublication(
  current: "draft" | "published" | "unpublished",
  requested: "published" | "unpublished" | undefined,
) {
  const status = requested ?? current;
  if (status === current)
    return { status, action: "contract_template.version_saved" } as const;
  switch (current) {
    case "draft":
      return status === "published"
        ? ({ status, action: "contract_template.published" } as const)
        : null;
    case "published":
      return { status, action: "contract_template.unpublished" } as const;
    case "unpublished":
      return { status, action: "contract_template.published" } as const;
  }
}

/** Preview-only stand-ins never enter either the template or a contract snapshot. */
export async function templatePreview(
  input: z.output<typeof contractTemplatesRoutes.createAuthored.body>,
) {
  const identities = new Set(
    input.definition.roles.flatMap(({ key }) => [
      `${key}.name`,
      `${key}.email`,
    ]),
  );
  const values = { ...input.authoring.values };
  const content = parseContractMarkdown(input.authoring.source);
  for (const block of content.content) {
    const paragraphs =
      block.type === "bulletList" || block.type === "orderedList"
        ? block.content.flatMap((item) => item.content)
        : [block];
    for (const paragraph of paragraphs) {
      for (const node of paragraph.content ?? []) {
        if (node.type === "contractValue")
          fillPreviewValue(values, identities, node.attrs.key);
      }
    }
  }
  const rendered = await renderTemplateContract({
    ...input.authoring,
    ...input.definition,
    dueDate: null,
    recipients: input.definition.roles.map(({ key, label, routingOrder }) => ({
      key,
      name: label,
      email: `[${label} email]`,
      routingOrder,
    })),
    title: input.name,
    values,
  });
  return {
    document: rendered.document,
    definition: {
      ...input.definition,
      fields: rendered.draft.fields.map(({ recipientKey, ...field }) => ({
        ...field,
        roleKey: recipientKey,
      })),
    },
  };
}

function fillPreviewValue(
  values: Record<string, string>,
  identities: ReadonlySet<string>,
  key: string,
) {
  if (
    !identities.has(key) &&
    (!Object.hasOwn(values, key) || !values[key]?.trim())
  )
    values[key] = `[${key}]`;
}

/** The source snapshot, PDF and placements are validated and generated together. */
export async function renderTemplateContract(input: ContractAuthoringInput) {
  const checked = ContractAuthoringSchema.safeParse(input);
  if (!checked.success)
    throw new ContractMarkdownError(
      checked.error.issues[0]?.message ??
        "The contract authoring input is invalid.",
    );
  const authoring = checked.data;
  const rendered = await renderContractMarkdown(authoring);
  if (rendered.bytes.byteLength > 10 * 1024 * 1024)
    throw new ContractMarkdownError(
      "Contract templates must be 10 MB or smaller.",
    );
  const draft = contractsRoutes.saveDraft.body.safeParse({
    ...authoring,
    fields: rendered.fields,
  });
  if (!draft.success)
    throw new ContractMarkdownError(
      draft.error.issues[0]?.message ?? "The generated fields are invalid.",
    );
  return {
    authoring,
    draft: draft.data,
    document: {
      bytes: rendered.bytes,
      filename: normalizeFilename(`${authoring.title}.pdf`, "contract.pdf"),
      pageCount: rendered.pageCount,
      sha256: await sha256Hex(rendered.bytes),
    },
  };
}

/**
 * Maps each role once; every field follows its role into the new draft,
 * which must then pass the contract's draft rules.
 */
export function mappedDraft(
  input: z.output<typeof contractTemplatesRoutes.createContract.body>,
  name: string,
  definition: TemplateDefinition,
  pageCount: number,
) {
  if (input.recipients.length !== definition.roles.length)
    return "Map every signer role to a person.";
  const keys = new Set<string>();
  const mapped = [];
  for (const recipient of input.recipients) {
    const role = definition.roles.find(
      (role) => role.key === recipient.roleKey,
    );
    if (!role || keys.has(role.key))
      return "Map every signer role exactly once.";
    keys.add(role.key);
    if (!recipient.name.trim()) return `Choose a name for ${role.label}.`;
    if (!validEmail(recipient.email.trim()))
      return `Choose a valid email address for ${role.label}.`;
    mapped.push({
      email: recipient.email,
      key: role.key,
      name: recipient.name,
      routingOrder: role.routingOrder,
    });
  }
  const draft = contractsRoutes.saveDraft.body.safeParse(
    {
      dueDate: input.dueDate,
      fields: definition.fields.map(({ roleKey, ...field }) => ({
        ...field,
        recipientKey: roleKey,
      })),
      message: definition.message,
      recipients: mapped,
      reminderIntervalDays: definition.reminderIntervalDays,
      signingOrder: definition.signingOrder,
      title: input.title ?? name,
    },
    { error: () => "The contract draft is invalid." },
  );
  if (!draft.success)
    return draft.error.issues[0]?.message ?? "The contract draft is invalid.";
  return fieldsOnDocument(draft.data.fields, pageCount)
    ? draft.data
    : offPageError;
}
