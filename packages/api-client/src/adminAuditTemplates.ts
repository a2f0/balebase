import type { adminAuditTemplatesRoutes } from "@balebase/validators/adminAuditTemplates";
import type { AuditTemplate } from "@balebase/validators/audits";
import { templateSaveBody } from "./audits";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof adminAuditTemplatesRoutes.list>({
    method: "GET",
    path: "/api/admin/audit-templates",
    response: "json",
  }),
  create: endpoint<typeof adminAuditTemplatesRoutes.create>({
    method: "POST",
    path: "/api/admin/audit-templates",
    body: "json",
    response: "json",
  }),
  versions: endpoint<typeof adminAuditTemplatesRoutes.versions>({
    method: "GET",
    path: "/api/admin/audit-templates/:id/versions",
    response: "json",
  }),
  version: endpoint<typeof adminAuditTemplatesRoutes.version>({
    method: "GET",
    path: "/api/admin/audit-templates/:id/versions/:version",
    response: "json",
  }),
  activity: endpoint<typeof adminAuditTemplatesRoutes.activity>({
    method: "GET",
    path: "/api/admin/audit-templates/:id/activity",
    response: "json",
  }),
  get: endpoint<typeof adminAuditTemplatesRoutes.get>({
    method: "GET",
    path: "/api/admin/audit-templates/:id",
    response: "json",
  }),
  update: endpoint<typeof adminAuditTemplatesRoutes.update>({
    method: "PUT",
    path: "/api/admin/audit-templates/:id",
    body: "json",
    response: "json",
  }),
  discard: endpoint<typeof adminAuditTemplatesRoutes.discard>({
    method: "DELETE",
    path: "/api/admin/audit-templates/:id",
    body: "json",
    response: "json",
  }),
};

/** Global forms, which only root admin's Global Audits can change. */
export function adminAuditTemplatesApi(transport: Transport) {
  return {
    list() {
      return transport.call(endpoints.list);
    },
    create(name: string) {
      return transport.call(endpoints.create, {
        body: { name },
      });
    },
    get(id: string) {
      return transport.call(endpoints.get, { params: { id } });
    },
    getVersion(id: string, version: number) {
      return transport.call(endpoints.version, {
        params: { id, version: String(version) },
      });
    },
    listVersions(id: string) {
      return transport.call(endpoints.versions, {
        params: { id },
      });
    },
    activity(id: string, cursor?: string) {
      return transport.call(endpoints.activity, {
        params: { id },
        query: { cursor },
      });
    },
    /** Saves the editor's copy, publishing or unpublishing it when asked. */
    update(template: AuditTemplate, status?: "published" | "unpublished") {
      return transport.call(endpoints.update, {
        body: { ...templateSaveBody(template), status },
        params: { id: template.id },
      });
    },
    /** Discards a draft, unless it changed since the editor loaded it. */
    discard(template: AuditTemplate) {
      return transport.call(endpoints.discard, {
        body: { expectedCurrentVersion: template.currentVersion },
        params: { id: template.id },
      });
    },
  };
}
