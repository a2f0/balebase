import { formsRoutes } from "@balebase/validators/forms";
import { projectsRoutes } from "@balebase/validators/projects";
import { activityCursor, type McpTool } from "./mcpToolSchema";

const templateSave = {
  definition:
    "The full definition. It replaces the saved one, so start from the current definition from get_form_template.",
  "definition.sections": "Sections in display order.",
  "definition.sections.id": "Stable section id.",
  "definition.sections.items": "Questions in display order.",
  "definition.sections.items.id":
    "Stable question id. Form responses and issues refer to it.",
  "definition.sections.items.prompt": "Question text.",
  "definition.sections.items.required": "Whether completion needs an answer.",
  "definition.sections.items.responseType":
    "check answers pass, fail, or na; text takes free text.",
  "definition.sections.title": "Section title.",
  "definition.version": "Always 1.",
  description: "Template description.",
  expectedCurrentVersion:
    "currentVersion from get_form_template; the save is rejected if someone saved a newer version.",
  name: "Template name.",
};

const templateId = { id: "Template id from list_form_templates." };
const formId = { id: "Form id from list_forms." };

export const formTools: McpTool[] = [
  {
    description:
      "Lists form templates: the organization's own templates and published global templates. Definitions are omitted; use get_form_template for the questions.",
    name: "list_form_templates",
    route: formsRoutes.listTemplates,
    title: "List form templates",
    transform: withoutTemplateDefinitions,
  },
  {
    description:
      "Gets a template's current version, including every section and question.",
    descriptions: templateId,
    name: "get_form_template",
    route: formsRoutes.getTemplate,
    title: "Get form template",
  },
  {
    description: "Lists a template's saved versions, newest first.",
    descriptions: templateId,
    name: "list_form_template_versions",
    route: formsRoutes.templateVersions,
    title: "List form template versions",
  },
  {
    description: "Gets one saved version of a template.",
    descriptions: { ...templateId, version: "Version number." },
    name: "get_form_template_version",
    route: formsRoutes.templateVersion,
    title: "Get form template version",
  },
  {
    description: "Lists who created and saved versions of a template.",
    descriptions: { ...templateId, ...activityCursor },
    name: "list_form_template_activity",
    route: formsRoutes.templateActivity,
    title: "List form template activity",
  },
  {
    description:
      "Creates a draft organization template with one placeholder question; edit it with save_form_template. Free organizations can have five templates.",
    descriptions: { name: templateSave.name },
    name: "create_form_template",
    // Organizations only create their own templates; global ones are an admin's.
    omit: ["scope"],
    route: formsRoutes.createTemplate,
    title: "Create form template",
  },
  {
    description:
      "Copies a published global template into a new organization template, with your name and definition changes.",
    descriptions: {
      ...templateSave,
      id: "Global template id from list_form_templates.",
      sourceVersion:
        "The published version you copied the definition from, recorded as the copy's source; omit to record only the template.",
    },
    name: "copy_form_template",
    route: formsRoutes.copyTemplate,
    title: "Copy global form template",
  },
  {
    description:
      "Saves a new version of an organization template. Existing forms keep the version they started from.",
    descriptions: {
      ...templateId,
      ...templateSave,
      status:
        "published or unpublished to change the template's publication (organization managers only); omit to keep it. Only published templates can be turned on for projects.",
    },
    name: "save_form_template",
    require: ["expectedCurrentVersion"],
    route: formsRoutes.updateTemplate,
    title: "Save form template",
  },
  {
    description:
      "Lists the organization's projects with member and form template counts. Every form belongs to a project; start_form needs one.",
    descriptions: {},
    name: "list_projects",
    route: projectsRoutes.list,
    title: "List projects",
  },
  {
    description:
      "Gets a project: its members and the form templates turned on for it, which start_form can start.",
    descriptions: { id: "Project id from list_projects." },
    name: "get_project",
    route: projectsRoutes.get,
    title: "Get project",
  },
  {
    description:
      "Starts a form for a project from a template's current version and returns its formId. The template must be turned on for the project.",
    descriptions: {
      ...templateId,
      projectId:
        "Project id the form belongs to; the template must be turned on for it.",
    },
    name: "start_form",
    route: formsRoutes.start,
    title: "Start form",
  },
  {
    description:
      "Lists forms, newest first, 100 per page, with status and issue counts. Pass nextCursor to page.",
    descriptions: {
      cursor: "nextCursor from the previous page.",
      view: "active (default) or deleted (discarded) forms.",
    },
    name: "list_forms",
    route: formsRoutes.listRuns,
    title: "List forms",
  },
  {
    description:
      "Gets a form: its questions, responses keyed by question id, revision, issues, and the members issues can be assigned to.",
    descriptions: formId,
    name: "get_form",
    route: formsRoutes.getRun,
    title: "Get form",
  },
  {
    description:
      "Lists a form's history: answers changed, issues raised, and completion.",
    descriptions: { ...formId, ...activityCursor },
    name: "list_form_activity",
    route: formsRoutes.runActivity,
    title: "List form activity",
  },
  {
    description: "Saves a form's answers and optionally completes it.",
    descriptions: {
      ...formId,
      expectedRevision:
        "revision from the latest get_form; the save is rejected if the form changed since. The next revision is this plus one.",
      responses:
        'Every answer keyed by question id: "pass", "fail", or "na" for check questions, any text for text questions. This replaces all saved answers, so include the existing ones you want to keep.',
      status:
        "completed requires every required question to be answered; in_progress reopens a completed form.",
    },
    name: "save_form",
    route: formsRoutes.saveRun,
    title: "Save form",
  },
  {
    description:
      "Discards an in-progress form. It moves to the deleted view and can no longer change.",
    descriptions: formId,
    destructive: true,
    name: "discard_form",
    route: formsRoutes.discardRun,
    title: "Discard form",
  },
  {
    description: "Raises an issue against one question in a form.",
    descriptions: {
      ...formId,
      assignedTo: "User id of the member to assign, from get_form members.",
      description: "Details.",
      itemId: "Id of the question the issue is about.",
      priority: "Defaults to medium.",
      title: "Issue title.",
    },
    name: "create_form_issue",
    route: formsRoutes.createIssue,
    title: "Create form issue",
  },
  {
    description:
      "Resolves, reopens, or reassigns a form issue. Send status, assignedTo, or both.",
    descriptions: {
      assignedTo: "User id of the member to assign, or null to unassign.",
      id: "Issue id from get_form.",
      status: "Issue status.",
    },
    name: "update_form_issue",
    route: formsRoutes.updateIssue,
    title: "Update form issue",
  },
  {
    description: "Removes an image from a form issue.",
    descriptions: {
      imageId: "Image id from the issue in get_form.",
      issueId: "Issue id from get_form.",
    },
    destructive: true,
    name: "remove_form_issue_image",
    route: formsRoutes.deleteIssueImage,
    title: "Remove form issue image",
  },
];

/** Global templates can hold hundreds of questions; listings only need counts. */
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
