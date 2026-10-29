import type { AuditDefinition } from "@balebase/validators/audits";

export function auditItems(definition: AuditDefinition) {
  return definition.sections.flatMap((section) => section.items);
}

export function isAnswered(response: string | undefined) {
  return Boolean(response?.trim());
}

/**
 * Answered, failed, and required-remaining counts. The API completes an
 * audit only once no required question is left.
 */
export function progressFor(
  definition: AuditDefinition,
  responses: Record<string, string>,
) {
  const items = auditItems(definition);
  const unanswered = items.filter((item) => !isAnswered(responses[item.id]));
  return {
    answered: items.length - unanswered.length,
    failed: items.filter((item) => responses[item.id] === "fail").length,
    requiredLeft: unanswered.filter((item) => item.required).length,
    total: items.length,
  };
}
