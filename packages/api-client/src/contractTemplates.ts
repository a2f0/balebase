import type {
  ContractTemplate,
  contractTemplatesRoutes,
  TemplateContractInput,
  TemplateVersionInput,
} from "@balebase/validators/contractTemplates";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof contractTemplatesRoutes.list>({
    method: "GET",
    path: "/api/contracts/templates",
    response: "json",
  }),
  upload: endpoint<typeof contractTemplatesRoutes.upload>({
    method: "POST",
    path: "/api/contracts/templates",
    body: "form",
    response: "json",
  }),
  get: endpoint<typeof contractTemplatesRoutes.get>({
    method: "GET",
    path: "/api/contracts/templates/:id",
    response: "json",
  }),
  versions: endpoint<typeof contractTemplatesRoutes.versions>({
    method: "GET",
    path: "/api/contracts/templates/:id/versions",
    response: "json",
  }),
  activity: endpoint<typeof contractTemplatesRoutes.activity>({
    method: "GET",
    path: "/api/contracts/templates/:id/activity",
    response: "json",
  }),
  document: endpoint<typeof contractTemplatesRoutes.document>({
    method: "GET",
    path: "/api/contracts/templates/:id/document",
    response: "file",
  }),
  saveVersion: endpoint<typeof contractTemplatesRoutes.saveVersion>({
    method: "POST",
    path: "/api/contracts/templates/:id/versions",
    body: "json",
    response: "json",
  }),
  createContract: endpoint<typeof contractTemplatesRoutes.createContract>({
    method: "POST",
    path: "/api/contracts/templates/:id/contracts",
    body: "json",
    response: "json",
  }),
  delete: endpoint<typeof contractTemplatesRoutes.delete>({
    method: "DELETE",
    path: "/api/contracts/templates/:id",
    response: "empty",
  }),
};

export function contractTemplatesApi(transport: Transport) {
  return {
    async list() {
      return (await transport.call(endpoints.list)).templates;
    },
    /** Uploads a PDF as a new template with one signer role. */
    async upload(file: File) {
      const body = new FormData();
      body.set("file", file);
      return (await transport.call(endpoints.upload, { body })).template;
    },
    /** A version of the template; the latest without one. */
    async get(id: string, version?: number) {
      return (
        await transport.call(endpoints.get, {
          params: { id },
          query: { version: version?.toString() },
        })
      ).template;
    },
    async versions(id: string) {
      return (
        await transport.call(endpoints.versions, {
          params: { id },
        })
      ).versions;
    },
    /** The template's history, newest first. */
    activity(id: string, cursor?: string) {
      return transport.call(endpoints.activity, {
        params: { id },
        query: { cursor },
      });
    },
    /** Saves a new version on top of the one being edited. */
    async saveVersion(
      template: Pick<ContractTemplate, "currentVersion" | "id" | "version">,
      input: TemplateVersionInput,
    ) {
      return (
        await transport.call(endpoints.saveVersion, {
          body: {
            ...input,
            expectedCurrentVersion: template.currentVersion,
            sourceVersion: template.version,
          },
          params: { id: template.id },
        })
      ).template;
    },
    /** Creates a draft contract from a version, returning its id. */
    async createContract(id: string, input: TemplateContractInput) {
      return (
        await transport.call(endpoints.createContract, {
          body: input,
          params: { id },
        })
      ).contractId;
    },
    delete(id: string) {
      return transport.call(endpoints.delete, { params: { id } });
    },
    /** A version's PDF. */
    async loadDocument(id: string, version: number) {
      const response = await transport.call(endpoints.document, {
        params: { id },
        query: { version: String(version) },
      });
      return response.arrayBuffer();
    },
  };
}
