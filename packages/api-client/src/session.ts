import { sessionRoutes } from "@balebase/validators/session";
import type { Transport } from "./transport";

export function sessionApi(transport: Transport) {
  return {
    me() {
      return transport.call(sessionRoutes.me);
    },
  };
}
