import { contractsRoutes } from "@balebase/validators/contracts";
import type {
  contractTemplatesRoutes,
  TemplateDefinition,
} from "@balebase/validators/contractTemplates";
import type { z } from "zod";
import { fieldsOnDocument, offPageError, validEmail } from "./contractDraft";

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
