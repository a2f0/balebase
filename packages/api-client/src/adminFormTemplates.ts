import type {
  AdminTemplateView,
  adminFormTemplatesRoutes,
} from "@balebase/validators/adminFormTemplates";
import type { FormTemplate } from "@balebase/validators/forms";
import { endpoint } from "./endpoint";
import { templateSaveBody } from "./forms";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof adminFormTemplatesRoutes.list>({
    method: "GET",
    path: "/api/admin/form-templates",
    response: "json",
  }),
  create: endpoint<typeof adminFormTemplatesRoutes.create>({
    method: "POST",
    path: "/api/admin/form-templates",
    body: "json",
    response: "json",
  }),
  versions: endpoint<typeof adminFormTemplatesRoutes.versions>({
    method: "GET",
    path: "/api/admin/form-templates/:id/versions",
    response: "json",
  }),
  version: endpoint<typeof adminFormTemplatesRoutes.version>({
    method: "GET",
    path: "/api/admin/form-templates/:id/versions/:version",
    response: "json",
  }),
  activity: endpoint<typeof adminFormTemplatesRoutes.activity>({
    method: "GET",
    path: "/api/admin/form-templates/:id/activity",
    response: "json",
  }),
  get: endpoint<typeof adminFormTemplatesRoutes.get>({
    method: "GET",
    path: "/api/admin/form-templates/:id",
    response: "json",
  }),
  update: endpoint<typeof adminFormTemplatesRoutes.update>({
    method: "PUT",
    path: "/api/admin/form-templates/:id",
    body: "json",
    response: "json",
  }),
  discard: endpoint<typeof adminFormTemplatesRoutes.discard>({
    method: "DELETE",
    path: "/api/admin/form-templates/:id",
    body: "json",
    response: "json",
  }),
  restore: endpoint<typeof adminFormTemplatesRoutes.restore>({
    method: "POST",
    path: "/api/admin/form-templates/:id/restore",
    body: "json",
    response: "json",
  }),
};

/** Global templates, which only root admin's Global templates can change. */
export function adminFormTemplatesApi(transport: Transport) {
  return {
    /** Global templates in use, or with `"discarded"`, those awaiting the purge. */
    list(view?: AdminTemplateView) {
      return transport.call(endpoints.list, { query: { view } });
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
    update(template: FormTemplate, status?: "published" | "unpublished") {
      return transport.call(endpoints.update, {
        body: { ...templateSaveBody(template), status },
        params: { id: template.id },
      });
    },
    /**
     * Discards a draft or unpublished template, unless it changed since the
     * editor loaded it.
     */
    discard(template: FormTemplate) {
      return transport.call(endpoints.discard, {
        body: { expectedCurrentVersion: template.currentVersion },
        params: { id: template.id },
      });
    },
    /** Restores a discarded template, unless it changed since it was listed. */
    restore(template: FormTemplate) {
      return transport.call(endpoints.restore, {
        body: { expectedCurrentVersion: template.currentVersion },
        params: { id: template.id },
      });
    },
  };
}
