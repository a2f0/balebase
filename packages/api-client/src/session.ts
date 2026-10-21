import type { sessionRoutes } from "@balebase/validators/session";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  me: endpoint<typeof sessionRoutes.me>({
    method: "GET",
    path: "/api/me",
    response: "json",
  }),
};

export function sessionApi(transport: Transport) {
  return {
    me() {
      return transport.call(endpoints.me);
    },
  };
}
