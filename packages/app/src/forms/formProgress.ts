import type { FormDefinition } from "@balebase/validators/forms";

export function formItems(definition: FormDefinition) {
  return definition.sections.flatMap((section) => section.items);
}

export function isAnswered(response: string | undefined) {
  return Boolean(response?.trim());
}

/**
 * Answered, failed, and required-remaining counts. The API completes an
 * form only once no required question is left.
 */
export function progressFor(
  definition: FormDefinition,
  responses: Record<string, string>,
) {
  const items = formItems(definition);
  const unanswered = items.filter((item) => !isAnswered(responses[item.id]));
  return {
    answered: items.length - unanswered.length,
    failed: items.filter((item) => responses[item.id] === "fail").length,
    requiredLeft: unanswered.filter((item) => item.required).length,
    total: items.length,
  };
}
