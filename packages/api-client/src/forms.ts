import type {
  FormIssueInput,
  FormIssueUpdate,
  FormRunView,
  FormStatus,
  FormTemplate,
  formsRoutes,
  TemplatePublication,
} from "@balebase/validators/forms";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  listTemplates: endpoint<typeof formsRoutes.listTemplates>({
    method: "GET",
    path: "/api/forms/templates",
    response: "json",
  }),
  createTemplate: endpoint<typeof formsRoutes.createTemplate>({
    method: "POST",
    path: "/api/forms/templates",
    body: "json",
    response: "json",
  }),
  copyTemplate: endpoint<typeof formsRoutes.copyTemplate>({
    method: "POST",
    path: "/api/forms/templates/:id/copies",
    body: "json",
    response: "json",
  }),
  templateVersions: endpoint<typeof formsRoutes.templateVersions>({
    method: "GET",
    path: "/api/forms/templates/:id/versions",
    response: "json",
  }),
  templateVersion: endpoint<typeof formsRoutes.templateVersion>({
    method: "GET",
    path: "/api/forms/templates/:id/versions/:version",
    response: "json",
  }),
  getTemplate: endpoint<typeof formsRoutes.getTemplate>({
    method: "GET",
    path: "/api/forms/templates/:id",
    response: "json",
  }),
  templateActivity: endpoint<typeof formsRoutes.templateActivity>({
    method: "GET",
    path: "/api/forms/templates/:id/activity",
    response: "json",
  }),
  updateTemplate: endpoint<typeof formsRoutes.updateTemplate>({
    method: "PUT",
    path: "/api/forms/templates/:id",
    body: "json",
    response: "json",
  }),
  start: endpoint<typeof formsRoutes.start>({
    method: "POST",
    path: "/api/forms/templates/:id/runs",
    body: "json",
    response: "json",
  }),
  listRuns: endpoint<typeof formsRoutes.listRuns>({
    method: "GET",
    path: "/api/forms/runs",
    response: "json",
  }),
  getRun: endpoint<typeof formsRoutes.getRun>({
    method: "GET",
    path: "/api/forms/runs/:id",
    response: "json",
  }),
  runActivity: endpoint<typeof formsRoutes.runActivity>({
    method: "GET",
    path: "/api/forms/runs/:id/activity",
    response: "json",
  }),
  saveRun: endpoint<typeof formsRoutes.saveRun>({
    method: "PATCH",
    path: "/api/forms/runs/:id",
    body: "json",
    response: "json",
  }),
  createIssue: endpoint<typeof formsRoutes.createIssue>({
    method: "POST",
    path: "/api/forms/runs/:id/issues",
    body: "json",
    response: "json",
  }),
  updateIssue: endpoint<typeof formsRoutes.updateIssue>({
    method: "PATCH",
    path: "/api/forms/issues/:id",
    body: "json",
    response: "json",
  }),
  discardRun: endpoint<typeof formsRoutes.discardRun>({
    method: "DELETE",
    path: "/api/forms/runs/:id",
    response: "json",
  }),
  uploadIssueImage: endpoint<typeof formsRoutes.uploadIssueImage>({
    method: "POST",
    path: "/api/forms/issues/:issueId/images",
    body: "file",
    response: "json",
  }),
  issueImage: endpoint<typeof formsRoutes.issueImage>({
    method: "GET",
    path: "/api/forms/issues/:issueId/images/:imageId",
    response: "file",
  }),
  deleteIssueImage: endpoint<typeof formsRoutes.deleteIssueImage>({
    method: "DELETE",
    path: "/api/forms/issues/:issueId/images/:imageId",
    response: "json",
  }),
};

/** The editor's copy of a template, saved as its next version. */
export function templateSaveBody(template: FormTemplate) {
  return {
    definition: template.definition,
    description: template.description,
    expectedCurrentVersion: template.currentVersion,
    name: template.name,
  };
}

/**
 * An organization's forms. Its templates include published global templates,
 * which it can run or customize as a copy of its own.
 */
export function formsApi(transport: Transport) {
  return {
    listTemplates() {
      return transport.call(endpoints.listTemplates);
    },
    createTemplate(name: string) {
      return transport.call(endpoints.createTemplate, { body: { name } });
    },
    getTemplate(id: string) {
      return transport.call(endpoints.getTemplate, { params: { id } });
    },
    getTemplateVersion(id: string, version: number) {
      return transport.call(endpoints.templateVersion, {
        params: { id, version: String(version) },
      });
    },
    listTemplateVersions(id: string) {
      return transport.call(endpoints.templateVersions, { params: { id } });
    },
    templateActivity(id: string, cursor?: string) {
      return transport.call(endpoints.templateActivity, {
        params: { id },
        query: { cursor },
      });
    },
    /**
     * Saves the editor's copy of an organization template, publishing or
     * unpublishing it when asked.
     */
    updateTemplate(template: FormTemplate, status?: TemplatePublication) {
      return transport.call(endpoints.updateTemplate, {
        body: { ...templateSaveBody(template), status },
        params: { id: template.id },
      });
    },
    /** Saves a global template's edits as a new template of the organization's own. */
    copyTemplate(template: FormTemplate) {
      return transport.call(endpoints.copyTemplate, {
        body: {
          ...templateSaveBody(template),
          sourceVersion: template.version,
        },
        params: { id: template.id },
      });
    },
    /** Starts a form for `projectId` from a template turned on for it. */
    start(templateId: string, projectId: string) {
      return transport.call(endpoints.start, {
        body: { projectId },
        params: { id: templateId },
      });
    },
    listRuns(cursor?: string, view: FormRunView = "active") {
      return transport.call(endpoints.listRuns, {
        query: { cursor, view: view === "deleted" ? view : undefined },
      });
    },
    getRun(id: string) {
      return transport.call(endpoints.getRun, { params: { id } });
    },
    runActivity(id: string, cursor?: string) {
      return transport.call(endpoints.runActivity, {
        params: { id },
        query: { cursor },
      });
    },
    saveRun(
      id: string,
      responses: Record<string, string>,
      status: FormStatus,
      expectedRevision: number,
    ) {
      return transport.call(endpoints.saveRun, {
        body: { expectedRevision, responses, status },
        params: { id },
      });
    },
    /** Moves an in-progress form to the Deleted view, where it stays read-only. */
    discardRun(id: string) {
      return transport.call(endpoints.discardRun, { params: { id } });
    },
    createIssue(formId: string, issue: FormIssueInput) {
      return transport.call(endpoints.createIssue, {
        body: issue,
        params: { id: formId },
      });
    },
    updateIssue(issueId: string, update: FormIssueUpdate) {
      return transport.call(endpoints.updateIssue, {
        body: update,
        params: { id: issueId },
      });
    },
    uploadIssueImage(issueId: string, file: File) {
      return transport.call(endpoints.uploadIssueImage, {
        body: file,
        params: { issueId },
        query: { filename: file.name },
      });
    },
    deleteIssueImage(issueId: string, imageId: string) {
      return transport.call(endpoints.deleteIssueImage, {
        params: { imageId, issueId },
      });
    },
    issueImageUrl(issueId: string, imageId: string, variant?: "thumbnail") {
      return transport.url(endpoints.issueImage, {
        params: { imageId, issueId },
        query: { variant },
      });
    },
  };
}
