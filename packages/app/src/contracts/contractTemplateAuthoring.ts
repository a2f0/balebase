import type { ContractAuthoringInput } from "@balebase/validators/contractAuthoring";
import { parseContractMarkdown } from "@balebase/validators/contractMarkdown";
import type {
  ContractTemplate,
  CreateAuthoredTemplateInput,
} from "@balebase/validators/contractTemplates";

/** Copy reusable text and literals, never signer identities or a due date. */
export function writtenTemplateInput(
  draft: ContractAuthoringInput,
  name = draft.title,
): CreateAuthoredTemplateInput {
  const identityKeys = new Set(
    draft.recipients.flatMap(({ key }) => [`${key}.name`, `${key}.email`]),
  );
  return {
    name,
    description: "",
    authoring: {
      formatVersion: 1 as const,
      source: draft.source,
      values: Object.fromEntries(
        Object.entries(draft.values).filter(([key]) => !identityKeys.has(key)),
      ),
    },
    definition: {
      fields: [],
      roles: draft.recipients.map(({ key, routingOrder }) => ({
        key,
        label: key
          .replace(/[-_]/g, " ")
          .replace(/\b[a-z]/g, (letter) => letter.toUpperCase()),
        routingOrder,
      })),
      message: draft.message,
      reminderIntervalDays: draft.reminderIntervalDays,
      signingOrder: draft.signingOrder,
    },
  };
}

/** Includes unresolved custom keys so every use can supply missing defaults. */
export function templateValueKeys(template: ContractTemplate) {
  if (!template.authoring) return [];
  const identities = new Set(
    template.definition.roles.flatMap(({ key }) => [
      `${key}.name`,
      `${key}.email`,
    ]),
  );
  const keys = new Set(Object.keys(template.authoring.values));
  for (const block of parseContractMarkdown(template.authoring.source)
    .content) {
    const paragraphs =
      block.type === "bulletList" || block.type === "orderedList"
        ? block.content.flatMap((item) => item.content)
        : [block];
    for (const paragraph of paragraphs) {
      for (const inline of paragraph.content ?? []) {
        if (inline.type === "contractValue") keys.add(inline.attrs.key);
      }
    }
  }
  return [...keys].filter((key) => !identities.has(key));
}
