import type { AuditDefinition } from "@balebase/validators/audits";
import { isRecord } from "./shared/jsonInput";

export function parseResponses(value: unknown, definition: AuditDefinition) {
  if (!isRecord(value) || Object.keys(value).length > 5_000) return null;
  const items = new Map(
    definition.sections.flatMap((section) =>
      section.items.map((item) => [item.id, item] as const),
    ),
  );
  const responses: Record<string, string> = {};
  for (const [itemId, response] of Object.entries(value)) {
    const item = items.get(itemId);
    if (!item || typeof response !== "string" || response.length > 2_000) {
      return null;
    }
    if (
      item.responseType === "check" &&
      !["pass", "fail", "na"].includes(response)
    ) {
      return null;
    }
    responses[itemId] = response;
  }
  return responses;
}

export function allRequiredAnswered(
  definition: AuditDefinition,
  responses: Record<string, string>,
) {
  return definition.sections.every((section) =>
    section.items.every(
      (item) => !item.required || Boolean(responses[item.id]?.trim()),
    ),
  );
}
