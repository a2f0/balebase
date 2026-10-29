import type {
  NewProject,
  ProjectChanges,
  projectsRoutes,
} from "@balebase/validators/projects";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof projectsRoutes.list>({
    method: "GET",
    path: "/api/projects",
    response: "json",
  }),
  create: endpoint<typeof projectsRoutes.create>({
    method: "POST",
    path: "/api/projects",
    body: "json",
    response: "json",
  }),
  get: endpoint<typeof projectsRoutes.get>({
    method: "GET",
    path: "/api/projects/:id",
    response: "json",
  }),
  activity: endpoint<typeof projectsRoutes.activity>({
    method: "GET",
    path: "/api/projects/:id/activity",
    response: "json",
  }),
  update: endpoint<typeof projectsRoutes.update>({
    method: "PATCH",
    path: "/api/projects/:id",
    body: "json",
    response: "json",
  }),
  delete: endpoint<typeof projectsRoutes.delete>({
    method: "DELETE",
    path: "/api/projects/:id",
    response: "empty",
  }),
  addMember: endpoint<typeof projectsRoutes.addMember>({
    method: "PUT",
    path: "/api/projects/:id/members/:userId",
    response: "json",
  }),
  removeMember: endpoint<typeof projectsRoutes.removeMember>({
    method: "DELETE",
    path: "/api/projects/:id/members/:userId",
    response: "json",
  }),
  enableForm: endpoint<typeof projectsRoutes.enableForm>({
    method: "PUT",
    path: "/api/projects/:id/forms/:templateId",
    response: "json",
  }),
  disableForm: endpoint<typeof projectsRoutes.disableForm>({
    method: "DELETE",
    path: "/api/projects/:id/forms/:templateId",
    response: "json",
  }),
};

export function projectsApi(transport: Transport) {
  return {
    list() {
      return transport.call(endpoints.list);
    },
    /** A project with the people and forms that can be added to it. */
    get(id: string) {
      return transport.call(endpoints.get, { params: { id } });
    },
    activity(id: string, cursor?: string) {
      return transport.call(endpoints.activity, {
        params: { id },
        query: { cursor },
      });
    },
    async create(input: NewProject) {
      const { project } = await transport.call(endpoints.create, {
        body: input,
      });
      return project;
    },
    async update(id: string, changes: ProjectChanges) {
      const { project } = await transport.call(endpoints.update, {
        body: changes,
        params: { id },
      });
      return project;
    },
    delete(id: string) {
      return transport.call(endpoints.delete, { params: { id } });
    },
    async addMember(id: string, userId: string) {
      const { project } = await transport.call(endpoints.addMember, {
        params: { id, userId },
      });
      return project;
    },
    async removeMember(id: string, userId: string) {
      const { project } = await transport.call(endpoints.removeMember, {
        params: { id, userId },
      });
      return project;
    },
    /** Turns an audit form on or off for the project. */
    async setForm(id: string, templateId: string, enabled: boolean) {
      const options = { params: { id, templateId } };
      const { project } = enabled
        ? await transport.call(endpoints.enableForm, options)
        : await transport.call(endpoints.disableForm, options);
      return project;
    },
  };
}
