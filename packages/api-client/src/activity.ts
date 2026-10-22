import type {
  ActivityResourceType,
  activityRoutes,
} from "@balebase/validators/activity";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof activityRoutes.list>({
    method: "GET",
    path: "/api/activity",
    response: "json",
  }),
};

export function activityApi(transport: Transport) {
  return {
    /** The organization's activity, newest first. */
    list(cursor?: string, resourceType?: ActivityResourceType) {
      return transport.call(endpoints.list, {
        query: { cursor, resourceType },
      });
    },
  };
}
