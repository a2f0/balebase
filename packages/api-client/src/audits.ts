import type {
  AuditIssueInput,
  AuditIssueUpdate,
  AuditRunView,
  AuditStatus,
  AuditTemplate,
  auditsRoutes,
  TemplatePublication,
} from "@balebase/validators/audits";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  listTemplates: endpoint<typeof auditsRoutes.listTemplates>({
    method: "GET",
    path: "/api/audits/templates",
    response: "json",
  }),
  createTemplate: endpoint<typeof auditsRoutes.createTemplate>({
    method: "POST",
    path: "/api/audits/templates",
    body: "json",
    response: "json",
  }),
  copyTemplate: endpoint<typeof auditsRoutes.copyTemplate>({
    method: "POST",
    path: "/api/audits/templates/:id/copies",
    body: "json",
    response: "json",
  }),
  templateVersions: endpoint<typeof auditsRoutes.templateVersions>({
    method: "GET",
    path: "/api/audits/templates/:id/versions",
    response: "json",
  }),
  templateVersion: endpoint<typeof auditsRoutes.templateVersion>({
    method: "GET",
    path: "/api/audits/templates/:id/versions/:version",
    response: "json",
  }),
  getTemplate: endpoint<typeof auditsRoutes.getTemplate>({
    method: "GET",
    path: "/api/audits/templates/:id",
    response: "json",
  }),
  templateActivity: endpoint<typeof auditsRoutes.templateActivity>({
    method: "GET",
    path: "/api/audits/templates/:id/activity",
    response: "json",
  }),
  updateTemplate: endpoint<typeof auditsRoutes.updateTemplate>({
    method: "PUT",
    path: "/api/audits/templates/:id",
    body: "json",
    response: "json",
  }),
  start: endpoint<typeof auditsRoutes.start>({
    method: "POST",
    path: "/api/audits/templates/:id/runs",
    response: "json",
  }),
  listRuns: endpoint<typeof auditsRoutes.listRuns>({
    method: "GET",
    path: "/api/audits/runs",
    response: "json",
  }),
  getRun: endpoint<typeof auditsRoutes.getRun>({
    method: "GET",
    path: "/api/audits/runs/:id",
    response: "json",
  }),
  runActivity: endpoint<typeof auditsRoutes.runActivity>({
    method: "GET",
    path: "/api/audits/runs/:id/activity",
    response: "json",
  }),
  saveRun: endpoint<typeof auditsRoutes.saveRun>({
    method: "PATCH",
    path: "/api/audits/runs/:id",
    body: "json",
    response: "json",
  }),
  createIssue: endpoint<typeof auditsRoutes.createIssue>({
    method: "POST",
    path: "/api/audits/runs/:id/issues",
    body: "json",
    response: "json",
  }),
  updateIssue: endpoint<typeof auditsRoutes.updateIssue>({
    method: "PATCH",
    path: "/api/audits/issues/:id",
    body: "json",
    response: "json",
  }),
  discardRun: endpoint<typeof auditsRoutes.discardRun>({
    method: "DELETE",
    path: "/api/audits/runs/:id",
    response: "json",
  }),
  uploadIssueImage: endpoint<typeof auditsRoutes.uploadIssueImage>({
    method: "POST",
    path: "/api/audits/issues/:issueId/images",
    body: "file",
    response: "json",
  }),
  issueImage: endpoint<typeof auditsRoutes.issueImage>({
    method: "GET",
    path: "/api/audits/issues/:issueId/images/:imageId",
    response: "file",
  }),
  deleteIssueImage: endpoint<typeof auditsRoutes.deleteIssueImage>({
    method: "DELETE",
    path: "/api/audits/issues/:issueId/images/:imageId",
    response: "json",
  }),
};

/** The editor's copy of a template, saved as its next version. */
export function templateSaveBody(template: AuditTemplate) {
  return {
    definition: template.definition,
    description: template.description,
    expectedCurrentVersion: template.currentVersion,
    name: template.name,
  };
}

/**
 * An organization's audits. Its templates include published global forms,
 * which it can run or customize as a copy of its own.
 */
export function auditsApi(transport: Transport) {
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
     * Saves the editor's copy of an organization form, publishing or
     * unpublishing it when asked.
     */
    updateTemplate(template: AuditTemplate, status?: TemplatePublication) {
      return transport.call(endpoints.updateTemplate, {
        body: { ...templateSaveBody(template), status },
        params: { id: template.id },
      });
    },
    /** Saves a global form's edits as a new form of the organization's own. */
    copyTemplate(template: AuditTemplate) {
      return transport.call(endpoints.copyTemplate, {
        body: templateSaveBody(template),
        params: { id: template.id },
      });
    },
    start(templateId: string) {
      return transport.call(endpoints.start, {
        params: { id: templateId },
      });
    },
    listRuns(cursor?: string, view: AuditRunView = "active") {
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
      status: AuditStatus,
      expectedRevision: number,
    ) {
      return transport.call(endpoints.saveRun, {
        body: { expectedRevision, responses, status },
        params: { id },
      });
    },
    /** Moves an in-progress audit to the Deleted view, where it stays read-only. */
    discardRun(id: string) {
      return transport.call(endpoints.discardRun, { params: { id } });
    },
    createIssue(auditId: string, issue: AuditIssueInput) {
      return transport.call(endpoints.createIssue, {
        body: issue,
        params: { id: auditId },
      });
    },
    updateIssue(issueId: string, update: AuditIssueUpdate) {
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
