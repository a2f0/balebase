import { auditsRoutes } from "@balebase/validators/audits";
import { activityCursor, type McpTool } from "./mcpToolSchema";

const templateSave = {
  definition:
    "The full checklist. It replaces the saved one, so start from the current definition from get_audit_template.",
  "definition.sections": "Sections in display order.",
  "definition.sections.id": "Stable section id.",
  "definition.sections.items": "Questions in display order.",
  "definition.sections.items.id":
    "Stable question id. Audit responses and issues refer to it.",
  "definition.sections.items.prompt": "Question text.",
  "definition.sections.items.required": "Whether completion needs an answer.",
  "definition.sections.items.responseType":
    "check answers pass, fail, or na; text takes free text.",
  "definition.sections.title": "Section title.",
  "definition.version": "Always 1.",
  description: "Form description.",
  expectedCurrentVersion:
    "currentVersion from get_audit_template; the save is rejected if someone saved a newer version.",
  name: "Form name.",
};

const templateId = { id: "Form (template) id from list_audit_templates." };
const auditId = { id: "Audit id from list_audits." };

export const auditTools: McpTool[] = [
  {
    description:
      "Lists audit forms (checklist templates): the organization's own forms and published global forms. Definitions are omitted; use get_audit_template for the questions.",
    name: "list_audit_templates",
    route: auditsRoutes.listTemplates,
    title: "List audit forms",
    transform: withoutTemplateDefinitions,
  },
  {
    description:
      "Gets a form's current version, including every section and question.",
    descriptions: templateId,
    name: "get_audit_template",
    route: auditsRoutes.getTemplate,
    title: "Get audit form",
  },
  {
    description: "Lists a form's saved versions, newest first.",
    descriptions: templateId,
    name: "list_audit_template_versions",
    route: auditsRoutes.templateVersions,
    title: "List audit form versions",
  },
  {
    description: "Gets one saved version of a form.",
    descriptions: { ...templateId, version: "Version number." },
    name: "get_audit_template_version",
    route: auditsRoutes.templateVersion,
    title: "Get audit form version",
  },
  {
    description: "Lists who created and saved versions of a form.",
    descriptions: { ...templateId, ...activityCursor },
    name: "list_audit_template_activity",
    route: auditsRoutes.templateActivity,
    title: "List audit form activity",
  },
  {
    description:
      "Creates a draft organization form with one placeholder question; edit it with save_audit_template. Free organizations can have five forms.",
    descriptions: { name: templateSave.name },
    name: "create_audit_template",
    // Organizations only create their own forms; global ones are an admin's.
    omit: ["scope"],
    route: auditsRoutes.createTemplate,
    title: "Create audit form",
  },
  {
    description:
      "Copies a published global form into a new organization form, with your name and definition changes.",
    descriptions: {
      ...templateSave,
      id: "Global form id from list_audit_templates.",
      sourceVersion:
        "The published version you copied the definition from, recorded as the copy's source; omit to record only the form.",
    },
    name: "copy_audit_template",
    route: auditsRoutes.copyTemplate,
    title: "Copy global audit form",
  },
  {
    description:
      "Saves a new version of an organization form. Existing audits keep the version they started from.",
    descriptions: {
      ...templateId,
      ...templateSave,
      status:
        "published or unpublished to change the form's publication (organization managers only); omit to keep it. Only published forms can be turned on for projects.",
    },
    name: "save_audit_template",
    require: ["expectedCurrentVersion"],
    route: auditsRoutes.updateTemplate,
    title: "Save audit form",
  },
  {
    description:
      "Starts an audit from a form's current version and returns its auditId.",
    descriptions: templateId,
    name: "start_audit",
    route: auditsRoutes.start,
    title: "Start audit",
  },
  {
    description:
      "Lists audits, newest first, 100 per page, with status and issue counts. Pass nextCursor to page.",
    descriptions: {
      cursor: "nextCursor from the previous page.",
      view: "active (default) or deleted (discarded) audits.",
    },
    name: "list_audits",
    route: auditsRoutes.listRuns,
    title: "List audits",
  },
  {
    description:
      "Gets an audit: its questions, responses keyed by question id, revision, issues, and the members issues can be assigned to.",
    descriptions: auditId,
    name: "get_audit",
    route: auditsRoutes.getRun,
    title: "Get audit",
  },
  {
    description:
      "Lists an audit's history: answers changed, issues raised, and completion.",
    descriptions: { ...auditId, ...activityCursor },
    name: "list_audit_activity",
    route: auditsRoutes.runActivity,
    title: "List audit activity",
  },
  {
    description: "Saves an audit's answers and optionally completes it.",
    descriptions: {
      ...auditId,
      expectedRevision:
        "revision from the latest get_audit; the save is rejected if the audit changed since. The next revision is this plus one.",
      responses:
        'Every answer keyed by question id: "pass", "fail", or "na" for check questions, any text for text questions. This replaces all saved answers, so include the existing ones you want to keep.',
      status:
        "completed requires every required question to be answered; in_progress reopens a completed audit.",
    },
    name: "save_audit",
    route: auditsRoutes.saveRun,
    title: "Save audit",
  },
  {
    description:
      "Discards an in-progress audit. It moves to the deleted view and can no longer change.",
    descriptions: auditId,
    destructive: true,
    name: "discard_audit",
    route: auditsRoutes.discardRun,
    title: "Discard audit",
  },
  {
    description: "Raises an issue against one question in an audit.",
    descriptions: {
      ...auditId,
      assignedTo: "User id of the member to assign, from get_audit members.",
      description: "Details.",
      itemId: "Id of the question the issue is about.",
      priority: "Defaults to medium.",
      title: "Issue title.",
    },
    name: "create_audit_issue",
    route: auditsRoutes.createIssue,
    title: "Create audit issue",
  },
  {
    description:
      "Resolves, reopens, or reassigns an audit issue. Send status, assignedTo, or both.",
    descriptions: {
      assignedTo: "User id of the member to assign, or null to unassign.",
      id: "Issue id from get_audit.",
      status: "Issue status.",
    },
    name: "update_audit_issue",
    route: auditsRoutes.updateIssue,
    title: "Update audit issue",
  },
  {
    description: "Removes an image from an audit issue.",
    descriptions: {
      imageId: "Image id from the issue in get_audit.",
      issueId: "Issue id from get_audit.",
    },
    destructive: true,
    name: "remove_audit_issue_image",
    route: auditsRoutes.deleteIssueImage,
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
