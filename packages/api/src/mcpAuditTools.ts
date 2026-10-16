import type { JsonSchemaType } from "@modelcontextprotocol/server";
import {
  activityCursor,
  boolean,
  id,
  integer,
  list,
  type McpTool,
  nullable,
  object,
  oneOf,
  text,
} from "./mcpToolSchema";

const auditDefinition = object(
  "The full checklist. It replaces the saved one, so start from the current definition from get_audit_template.",
  {
    sections: list(
      "Sections in display order.",
      object(
        "A section.",
        {
          id: text("Stable section id.", { maxLength: 100, minLength: 1 }),
          items: list(
            "Questions in display order.",
            object(
              "A question.",
              {
                id: text(
                  "Stable question id. Audit responses and issues refer to it.",
                  { maxLength: 100, minLength: 1 },
                ),
                prompt: text("Question text.", {
                  maxLength: 500,
                  minLength: 1,
                }),
                required: boolean("Whether completion needs an answer."),
                responseType: oneOf(
                  "check answers pass, fail, or na; text takes free text.",
                  ["check", "text"],
                ),
              },
              ["id", "prompt", "required", "responseType"],
            ),
            { maxItems: 100 },
          ),
          title: text("Section title.", { maxLength: 200, minLength: 1 }),
        },
        ["id", "title", "items"],
      ),
      { maxItems: 50, minItems: 1 },
    ),
    version: { description: "Always 1.", enum: [1], type: "integer" },
  },
  ["version", "sections"],
);

const templateName = text("Form name.", { maxLength: 200, minLength: 1 });

const templateSave: Record<string, JsonSchemaType> = {
  definition: auditDefinition,
  description: text("Form description.", { maxLength: 2000 }),
  expectedCurrentVersion: integer(
    "currentVersion from get_audit_template; the save is rejected if someone saved a newer version.",
    { minimum: 1 },
  ),
  name: templateName,
};

const templateId = id("Form (template) id from list_audit_templates.");
const auditId = id("Audit id from list_audits.");

export const auditTools: McpTool[] = [
  {
    description:
      "Lists audit forms (checklist templates): the organization's own forms and published global forms. Definitions are omitted; use get_audit_template for the questions.",
    method: "GET",
    name: "list_audit_templates",
    path: "/api/audits/templates",
    title: "List audit forms",
    transform: withoutTemplateDefinitions,
  },
  {
    description:
      "Gets a form's current version, including every section and question.",
    method: "GET",
    name: "get_audit_template",
    params: { id: templateId },
    path: "/api/audits/templates/{id}",
    title: "Get audit form",
  },
  {
    description: "Lists a form's saved versions, newest first.",
    method: "GET",
    name: "list_audit_template_versions",
    params: { id: templateId },
    path: "/api/audits/templates/{id}/versions",
    title: "List audit form versions",
  },
  {
    description: "Gets one saved version of a form.",
    method: "GET",
    name: "get_audit_template_version",
    params: {
      id: templateId,
      version: integer("Version number.", { minimum: 1 }),
    },
    path: "/api/audits/templates/{id}/versions/{version}",
    title: "Get audit form version",
  },
  {
    description: "Lists who created and saved versions of a form.",
    method: "GET",
    name: "list_audit_template_activity",
    params: { id: templateId },
    path: "/api/audits/templates/{id}/activity",
    query: { cursor: activityCursor },
    title: "List audit form activity",
  },
  {
    body: { properties: { name: templateName }, required: ["name"] },
    description:
      "Creates a draft organization form with one placeholder question; edit it with save_audit_template. Free organizations can have five forms.",
    method: "POST",
    name: "create_audit_template",
    path: "/api/audits/templates",
    title: "Create audit form",
  },
  {
    body: {
      properties: templateSave,
      required: ["name", "definition"],
    },
    description:
      "Copies a published global form into a new organization form, with your name and definition changes.",
    method: "POST",
    name: "copy_audit_template",
    params: { id: id("Global form id from list_audit_templates.") },
    path: "/api/audits/templates/{id}/copies",
    title: "Copy global audit form",
  },
  {
    body: {
      properties: templateSave,
      required: ["name", "definition", "expectedCurrentVersion"],
    },
    description:
      "Saves a new version of an organization form. Existing audits keep the version they started from.",
    method: "PUT",
    name: "save_audit_template",
    params: { id: templateId },
    path: "/api/audits/templates/{id}",
    title: "Save audit form",
  },
  {
    description:
      "Starts an audit from a form's current version and returns its auditId.",
    method: "POST",
    name: "start_audit",
    params: { id: templateId },
    path: "/api/audits/templates/{id}/runs",
    title: "Start audit",
  },
  {
    description:
      "Lists audits, newest first, 100 per page, with status and issue counts. Pass nextCursor to page.",
    method: "GET",
    name: "list_audits",
    path: "/api/audits/runs",
    query: {
      cursor: text("nextCursor from the previous page.", { maxLength: 2048 }),
      view: oneOf("active (default) or deleted (discarded) audits.", [
        "active",
        "deleted",
      ]),
    },
    title: "List audits",
  },
  {
    description:
      "Gets an audit: its questions, responses keyed by question id, revision, issues, and the members issues can be assigned to.",
    method: "GET",
    name: "get_audit",
    params: { id: auditId },
    path: "/api/audits/runs/{id}",
    title: "Get audit",
  },
  {
    description:
      "Lists an audit's history: answers changed, issues raised, and completion.",
    method: "GET",
    name: "list_audit_activity",
    params: { id: auditId },
    path: "/api/audits/runs/{id}/activity",
    query: { cursor: activityCursor },
    title: "List audit activity",
  },
  {
    body: {
      properties: {
        expectedRevision: integer(
          "revision from the latest get_audit; the save is rejected if the audit changed since. The next revision is this plus one.",
          { minimum: 0 },
        ),
        responses: {
          additionalProperties: text(
            'Answer: "pass", "fail", or "na" for check questions; any text for text questions.',
            { maxLength: 2000 },
          ),
          description:
            "Every answer keyed by question id. This replaces all saved answers, so include the existing ones you want to keep.",
          type: "object",
        },
        status: oneOf(
          "completed requires every required question to be answered; in_progress reopens a completed audit.",
          ["in_progress", "completed"],
        ),
      },
      required: ["expectedRevision", "responses"],
    },
    description: "Saves an audit's answers and optionally completes it.",
    method: "PATCH",
    name: "save_audit",
    params: { id: auditId },
    path: "/api/audits/runs/{id}",
    title: "Save audit",
  },
  {
    description:
      "Discards an in-progress audit. It moves to the deleted view and can no longer change.",
    destructive: true,
    method: "DELETE",
    name: "discard_audit",
    params: { id: auditId },
    path: "/api/audits/runs/{id}",
    title: "Discard audit",
  },
  {
    body: {
      properties: {
        assignedTo: nullable(
          id("User id of the member to assign, from get_audit members."),
        ),
        description: text("Details.", { maxLength: 2000 }),
        itemId: text("Id of the question the issue is about.", {
          maxLength: 100,
          minLength: 1,
        }),
        priority: oneOf("Defaults to medium.", [
          "low",
          "medium",
          "high",
          "critical",
        ]),
        title: text("Issue title.", { maxLength: 300, minLength: 1 }),
      },
      required: ["itemId", "title"],
    },
    description: "Raises an issue against one question in an audit.",
    method: "POST",
    name: "create_audit_issue",
    params: { id: auditId },
    path: "/api/audits/runs/{id}/issues",
    title: "Create audit issue",
  },
  {
    body: {
      properties: {
        assignedTo: nullable(
          text("User id of the member to assign, or null to unassign.", {
            maxLength: 100,
          }),
        ),
        status: oneOf("Issue status.", ["open", "resolved"]),
      },
    },
    description:
      "Resolves, reopens, or reassigns an audit issue. Send status, assignedTo, or both.",
    method: "PATCH",
    name: "update_audit_issue",
    params: { id: id("Issue id from get_audit.") },
    path: "/api/audits/issues/{id}",
    title: "Update audit issue",
  },
  {
    description: "Removes an image from an audit issue.",
    destructive: true,
    method: "DELETE",
    name: "remove_audit_issue_image",
    params: {
      imageId: id("Image id from the issue in get_audit."),
      issueId: id("Issue id from get_audit."),
    },
    path: "/api/audits/issues/{issueId}/images/{imageId}",
    title: "Remove audit issue image",
  },
];

/** Global forms can hold hundreds of questions; listings only need counts. */
function withoutTemplateDefinitions(body: unknown) {
  if (typeof body !== "object" || body === null || !("templates" in body)) {
    return body;
  }
  const { templates } = body as { templates: unknown };
  if (!Array.isArray(templates)) return body;
  return {
    templates: templates.map((template: Record<string, unknown>) => {
      const { definition, ...summary } = template;
      const sections = (definition as { sections?: unknown } | undefined)
        ?.sections;
      return {
        ...summary,
        questionCount: Array.isArray(sections)
          ? sections.reduce(
              (count: number, section: { items?: unknown }) =>
                count +
                (Array.isArray(section.items) ? section.items.length : 0),
              0,
            )
          : 0,
        sectionCount: Array.isArray(sections) ? sections.length : 0,
      };
    }),
  };
}
