import type { ApiKeyInput, apiKeysRoutes } from "@balebase/validators/apiKeys";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof apiKeysRoutes.list>({
    method: "GET",
    path: "/api/organization-settings/api-keys",
    response: "json",
  }),
  create: endpoint<typeof apiKeysRoutes.create>({
    method: "POST",
    path: "/api/organization-settings/api-keys",
    body: "json",
    response: "json",
  }),
  revoke: endpoint<typeof apiKeysRoutes.revoke>({
    method: "DELETE",
    path: "/api/organization-settings/api-keys/:id",
    response: "json",
  }),
};

export function apiKeysApi(transport: Transport) {
  return {
    async list() {
      const body = await transport.call(endpoints.list);
      return body.apiKeys;
    },
    create(input: ApiKeyInput) {
      return transport.call(endpoints.create, { body: input });
    },
    async revoke(id: string) {
      const body = await transport.call(endpoints.revoke, {
        params: { id },
      });
      return body.apiKey;
    },
  };
}
