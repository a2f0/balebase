import type {
  AuditDefinition,
  AuditTemplateItem,
  AuditTemplateSection,
} from "@balebase/validators/audits";
import { isRecord, validText } from "./jsonInput";

const maxSections = 50;
const maxItemsPerSection = 100;

export function parseAuditDefinition(value: unknown): AuditDefinition | null {
  if (
    !isRecord<"sections" | "version">(value) ||
    value.version !== 1 ||
    !Array.isArray(value.sections)
  ) {
    return null;
  }
  if (value.sections.length === 0 || value.sections.length > maxSections) {
    return null;
  }
  const sections = value.sections.map(parseSection);
  return sections.every((section) => section !== null)
    ? { sections: sections as AuditTemplateSection[], version: 1 }
    : null;
}

function parseSection(value: unknown): AuditTemplateSection | null {
  if (!isRecord<"id" | "items" | "title">(value) || !validText(value.id, 100))
    return null;
  if (!validText(value.title, 200) || !Array.isArray(value.items)) {
    return null;
  }
  if (value.items.length > maxItemsPerSection) {
    return null;
  }
  const items = value.items.map(parseItem);
  return items.every((item) => item !== null)
    ? {
        id: value.id,
        items: items as AuditTemplateItem[],
        title: value.title.trim(),
      }
    : null;
}

function parseItem(value: unknown): AuditTemplateItem | null {
  if (
    !isRecord<"id" | "prompt" | "required" | "responseType">(value) ||
    !validText(value.id, 100)
  )
    return null;
  if (!validText(value.prompt, 500) || typeof value.required !== "boolean") {
    return null;
  }
  if (value.responseType !== "check" && value.responseType !== "text") {
    return null;
  }
  return {
    id: value.id,
    prompt: value.prompt.trim(),
    required: value.required,
    responseType: value.responseType,
  };
}

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
