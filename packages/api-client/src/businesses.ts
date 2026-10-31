import type {
  BusinessInput,
  businessesRoutes,
} from "@balebase/validators/businesses";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof businessesRoutes.list>({
    method: "GET",
    path: "/api/businesses",
    response: "json",
  }),
  get: endpoint<typeof businessesRoutes.get>({
    method: "GET",
    path: "/api/businesses/:id",
    response: "json",
  }),
  activity: endpoint<typeof businessesRoutes.activity>({
    method: "GET",
    path: "/api/businesses/:id/activity",
    response: "json",
  }),
  create: endpoint<typeof businessesRoutes.create>({
    method: "POST",
    path: "/api/businesses",
    body: "json",
    response: "json",
  }),
  update: endpoint<typeof businessesRoutes.update>({
    method: "PATCH",
    path: "/api/businesses/:id",
    body: "json",
    response: "json",
  }),
  delete: endpoint<typeof businessesRoutes.delete>({
    method: "DELETE",
    path: "/api/businesses/:id",
    response: "empty",
  }),
};

export function businessesApi(transport: Transport) {
  return {
    list() {
      return transport.call(endpoints.list);
    },
    get(id: string) {
      return transport.call(endpoints.get, { params: { id } });
    },
    /** The business's history, newest first. */
    activity(id: string, cursor?: string) {
      return transport.call(endpoints.activity, {
        params: { id },
        query: { cursor },
      });
    },
    create(input: BusinessInput) {
      return transport.call(endpoints.create, { body: input });
    },
    update(id: string, input: BusinessInput) {
      return transport.call(endpoints.update, {
        body: input,
        params: { id },
      });
    },
    delete(id: string) {
      return transport.call(endpoints.delete, { params: { id } });
    },
  };
}
