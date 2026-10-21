import { activityRoutes } from "@balebase/validators/activity";
import type { Transport } from "./transport";

export function activityApi(transport: Transport) {
  return {
    /** The organization's activity, newest first. */
    list(cursor?: string) {
      return transport.call(activityRoutes.list, { query: { cursor } });
    },
  };
}
