import type {
  ContractDraftInput,
  contractsRoutes,
} from "@balebase/validators/contracts";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof contractsRoutes.list>({
    method: "GET",
    path: "/api/contracts",
    response: "json",
  }),
  upload: endpoint<typeof contractsRoutes.upload>({
    method: "POST",
    path: "/api/contracts",
    body: "form",
    response: "json",
  }),
  get: endpoint<typeof contractsRoutes.get>({
    method: "GET",
    path: "/api/contracts/:id",
    response: "json",
  }),
  document: endpoint<typeof contractsRoutes.document>({
    method: "GET",
    path: "/api/contracts/:id/document",
    response: "file",
  }),
  final: endpoint<typeof contractsRoutes.final>({
    method: "GET",
    path: "/api/contracts/:id/final",
    response: "file",
  }),
  saveDraft: endpoint<typeof contractsRoutes.saveDraft>({
    method: "PUT",
    path: "/api/contracts/:id/draft",
    body: "json",
    response: "json",
  }),
  send: endpoint<typeof contractsRoutes.send>({
    method: "POST",
    path: "/api/contracts/:id/send",
    response: "json",
  }),
  remind: endpoint<typeof contractsRoutes.remind>({
    method: "POST",
    path: "/api/contracts/:id/remind",
    response: "json",
  }),
  void: endpoint<typeof contractsRoutes.void>({
    method: "POST",
    path: "/api/contracts/:id/void",
    body: "json",
    response: "json",
  }),
  delete: endpoint<typeof contractsRoutes.delete>({
    method: "DELETE",
    path: "/api/contracts/:id",
    response: "empty",
  }),
};

export function contractsApi(transport: Transport) {
  // Saves of one draft run one at a time, in order, and reads wait for them,
  // so a save fired while leaving the editor can't be overtaken or read stale.
  const draftSaves = new Map<string, Promise<unknown>>();
  return {
    async list() {
      return (await transport.call(endpoints.list)).contracts;
    },
    /** Uploads a PDF as a new draft. */
    async upload(file: File) {
      const body = new FormData();
      body.set("file", file);
      return (await transport.call(endpoints.upload, { body })).contract;
    },
    async get(id: string) {
      await draftSaves.get(id)?.catch(() => undefined);
      return (await transport.call(endpoints.get, { params: { id } })).contract;
    },
    /** Replaces a draft's details, signers, and fields. */
    saveDraft(id: string, draft: ContractDraftInput) {
      const previous = draftSaves.get(id) ?? Promise.resolve();
      const saving = previous
        .catch(() => undefined)
        .then(() =>
          transport.call(endpoints.saveDraft, {
            body: draft,
            params: { id },
          }),
        );
      draftSaves.set(id, saving);
      const settle = () => {
        if (draftSaves.get(id) === saving) draftSaves.delete(id);
      };
      saving.then(settle, settle);
      return saving.then(({ contract }) => contract);
    },
    async send(id: string) {
      return (await transport.call(endpoints.send, { params: { id } }))
        .contract;
    },
    /** Emails everyone whose turn it is again. */
    remind(id: string) {
      return transport.call(endpoints.remind, { params: { id } });
    },
    async void(id: string, reason: string) {
      return (
        await transport.call(endpoints.void, {
          body: { reason },
          params: { id },
        })
      ).contract;
    },
    delete(id: string) {
      return transport.call(endpoints.delete, { params: { id } });
    },
    /** The PDF as uploaded. */
    document(id: string) {
      return transport.call(endpoints.document, { params: { id } });
    },
    documentUrl(id: string) {
      return transport.url(endpoints.document, { params: { id } });
    },
    /** The signed PDF with its certificate, once everyone has signed. */
    final(id: string) {
      return transport.call(endpoints.final, { params: { id } });
    },
    finalUrl(id: string) {
      return transport.url(endpoints.final, { params: { id } });
    },
  };
}
